"""Active NWS alerts for Utah as map-ready GeoJSON.

Many Utah alerts (Air Quality Alerts in particular) are issued for forecast zones and arrive
with ``geometry: null``. This resolves each alert's zones to their outlines, merges them into
one MultiPolygon per alert, and rounds coordinates so the payload stays small. Zone outlines
rarely change, so they are cached for a day; the alert list itself for five minutes.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from backend.config import settings

logger = logging.getLogger(__name__)

ALERTS_URL = "https://api.weather.gov/alerts/active"
ALERTS_TTL_S = 300
ZONE_TTL_S = 86_400
MAX_ZONES = 60
PRECISION = 3  # ~100 m
THIN_DEG = 0.005  # drop vertices within ~500 m of the last kept one; plenty for a statewide overlay

_alerts_cache: tuple[float, dict[str, Any]] | None = None
_zone_cache: dict[str, tuple[float, list[Any] | None]] = {}


def _round_ring(ring: list[list[float]]) -> list[list[float]]:
    out: list[list[float]] = []
    for lon, lat, *_ in ring:
        point = [round(lon, PRECISION), round(lat, PRECISION)]
        if not out or max(abs(point[0] - out[-1][0]), abs(point[1] - out[-1][1])) >= THIN_DEG:
            out.append(point)
    if len(out) >= 3 and out[0] != out[-1]:
        out.append(out[0])
    return out


def _polygons(geometry: dict[str, Any] | None) -> list[Any]:
    """Polygon/MultiPolygon geometry -> list of rounded polygons (each a list of rings)."""
    if not geometry:
        return []
    kind, coords = geometry.get("type"), geometry.get("coordinates") or []
    polygons = [coords] if kind == "Polygon" else coords if kind == "MultiPolygon" else []
    rounded = []
    for polygon in polygons:
        rings = [_round_ring(ring) for ring in polygon]
        rings = [ring for ring in rings if len(ring) >= 4]
        if rings:
            rounded.append(rings)
    return rounded


async def _zone_polygons(client: httpx.AsyncClient, url: str, semaphore: asyncio.Semaphore) -> list[Any] | None:
    hit = _zone_cache.get(url)
    if hit and time.time() - hit[0] < ZONE_TTL_S:
        return hit[1]
    async with semaphore:
        try:
            response = await client.get(url)
            response.raise_for_status()
            polygons = _polygons(response.json().get("geometry"))
        except Exception as error:  # one missing zone should not drop the whole alert
            logger.info("NWS zone %s unavailable (%s)", url.rsplit("/", 1)[-1], type(error).__name__)
            return None
    _zone_cache[url] = (time.time(), polygons)
    return polygons


def _properties(props: dict[str, Any]) -> dict[str, Any]:
    description = " ".join(str(props.get("description") or "").split())
    return {
        "id": props.get("id"),
        "event": props.get("event"),
        "headline": props.get("headline"),
        "severity": props.get("severity"),
        "urgency": props.get("urgency"),
        "area": props.get("areaDesc"),
        "onset": props.get("onset") or props.get("effective"),
        "ends": props.get("ends") or props.get("expires"),
        "sender": props.get("senderName"),
        "summary": description[:500] + ("…" if len(description) > 500 else ""),
        "url": props.get("@id") or props.get("id"),
    }


async def utah_alerts() -> dict[str, Any]:
    """FeatureCollection of active Utah alerts with outlines. Raises when NWS is unreachable."""
    global _alerts_cache
    if _alerts_cache and time.time() - _alerts_cache[0] < ALERTS_TTL_S:
        return _alerts_cache[1]

    headers = {"User-Agent": settings.nws_user_agent, "Accept": "application/geo+json"}
    async with httpx.AsyncClient(headers=headers, timeout=10) as client:
        response = await client.get(ALERTS_URL, params={"area": "UT"})
        response.raise_for_status()
        raw = response.json().get("features") or []

        zone_urls: list[str] = []
        for feature in raw:
            if not feature.get("geometry"):
                for url in (feature.get("properties") or {}).get("affectedZones") or []:
                    if url not in zone_urls and len(zone_urls) < MAX_ZONES:
                        zone_urls.append(url)
        semaphore = asyncio.Semaphore(8)
        resolved = await asyncio.gather(*(_zone_polygons(client, url, semaphore) for url in zone_urls))
    zones = dict(zip(zone_urls, resolved))

    features, unmapped = [], []
    for feature in raw:
        props = feature.get("properties") or {}
        polygons = _polygons(feature.get("geometry"))
        if not polygons:
            for url in props.get("affectedZones") or []:
                polygons.extend(zones.get(url) or [])
        if polygons:
            features.append({
                "type": "Feature",
                "geometry": {"type": "MultiPolygon", "coordinates": polygons},
                "properties": _properties(props),
            })
        else:
            unmapped.append(_properties(props))

    payload = {"type": "FeatureCollection", "features": features, "unmapped": unmapped,
               "source_url": "https://www.weather.gov/slc/"}
    _alerts_cache = (time.time(), payload)
    return payload
