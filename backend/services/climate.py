"""Statewide gridded forecasts for the map's climate fields (temperature, wind, mixing height, PM2.5).

One Open-Meteo request per product covers an 18 x 18 grid over Utah for the next 72 hours:

* weather (``/v1/forecast``): 2 m temperature, 10 m wind, boundary-layer (mixing) height
* air quality (``/v1/air-quality``, CAMS model): PM2.5 and US AQI

The payload is compact: 3-hourly steps (the browser interpolates between them as the time slider
moves), values rounded, row-major from the south-west corner. Both products are cached in memory
and the API route adds CDN cache headers; Open-Meteo's free tier counts each grid point as a call,
so a refresh every few hours keeps well inside it.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)

BBOX = (-114.15, 36.9, -108.95, 42.1)  # W, S, E, N: Utah plus a small margin
GRID_N = 18
STEP_H = 3
HORIZON_H = 72
TTL_S = 2 * 3600

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

_cache: tuple[float, dict[str, Any]] | None = None
_lock = asyncio.Lock()


def grid_axes(n: int = GRID_N) -> tuple[list[float], list[float]]:
    w, s, e, nn = BBOX
    lats = [round(s + (nn - s) * i / (n - 1), 3) for i in range(n)]
    lons = [round(w + (e - w) * j / (n - 1), 3) for j in range(n)]
    return lats, lons


def _points(lats: list[float], lons: list[float]) -> tuple[str, str]:
    """Row-major (south row first, west to east) comma lists for Open-Meteo."""
    flat_lat = [lat for lat in lats for _ in lons]
    flat_lon = [lon for _ in lats for lon in lons]
    return ",".join(map(str, flat_lat)), ",".join(map(str, flat_lon))


def _steps(now: datetime) -> list[datetime]:
    start = now.replace(minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
    return [start + timedelta(hours=h) for h in range(0, HORIZON_H + 1, STEP_H)]


def _pick(locations: list[dict[str, Any]], variable: str, steps: list[datetime], digits: int | None) -> list[list[Any]]:
    """[step][point] values for one variable; None where the model has no value."""
    out: list[list[Any]] = []
    keys = [step.strftime("%Y-%m-%dT%H:%M") for step in steps]
    index = {t: i for i, t in enumerate(locations[0]["hourly"]["time"])}
    for key in keys:
        i = index.get(key)
        row = []
        for location in locations:
            value = location["hourly"].get(variable, [])[i] if i is not None else None
            if value is not None:
                value = round(value, digits) if digits else int(round(value))
            row.append(value)
        out.append(row)
    return out


async def _fetch(client: httpx.AsyncClient, url: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    for attempt in range(2):  # one retry: the provider occasionally drops a connection
        try:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            return data if isinstance(data, list) else [data]
        except httpx.HTTPError:
            if attempt:
                raise
            await asyncio.sleep(1)
    raise RuntimeError("unreachable")


async def climate_grid() -> dict[str, Any]:
    """Gridded fields for the next 72 hours. Raises only when both products are unavailable."""
    global _cache
    async with _lock:
        if _cache and time.time() - _cache[0] < TTL_S:
            return _cache[1]
        lats, lons = grid_axes()
        lat_param, lon_param = _points(lats, lons)
        common = {"latitude": lat_param, "longitude": lon_param, "timezone": "GMT", "forecast_days": 4}
        steps = _steps(datetime.now(timezone.utc))
        async with httpx.AsyncClient(timeout=30) as client:
            weather, air = await asyncio.gather(
                _fetch(client, FORECAST_URL, {**common, "hourly": "temperature_2m,wind_speed_10m,wind_direction_10m,boundary_layer_height",
                                              "temperature_unit": "fahrenheit", "wind_speed_unit": "mph"}),
                _fetch(client, AIR_URL, {**common, "hourly": "pm2_5,us_aqi"}),
                return_exceptions=True,
            )
        fields: dict[str, Any] = {}
        unavailable = []
        if isinstance(weather, list) and len(weather) == len(lats) * len(lons):
            fields["temp_f"] = _pick(weather, "temperature_2m", steps, None)
            fields["wind_mph"] = _pick(weather, "wind_speed_10m", steps, None)
            fields["wind_dir"] = _pick(weather, "wind_direction_10m", steps, None)
            fields["mix_m"] = _pick(weather, "boundary_layer_height", steps, None)
        else:
            logger.info("Open-Meteo weather grid unavailable (%s)", type(weather).__name__)
            unavailable.append("weather")
        if isinstance(air, list) and len(air) == len(lats) * len(lons):
            fields["pm25"] = _pick(air, "pm2_5", steps, 1)
            fields["aqi"] = _pick(air, "us_aqi", steps, None)
        else:
            logger.info("Open-Meteo air-quality grid unavailable (%s)", type(air).__name__)
            unavailable.append("air_quality")
        if not fields:
            raise RuntimeError("Open-Meteo grids unavailable")
        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "bbox": BBOX,
            "lats": lats,
            "lons": lons,
            "times": [step.isoformat() for step in steps],
            "fields": fields,
            "unavailable": unavailable,
            "sources": {
                "weather": "Open-Meteo forecast (best-match models incl. NOAA HRRR/GFS)",
                "air_quality": "Open-Meteo air quality (Copernicus CAMS model)",
            },
            "note": "Model forecasts on a ~30 km grid: good for regional patterns, not street-level readings.",
        }
        # A partial grid is cached briefly so a recovered product shows up soon.
        _cache = (time.time() - (TTL_S - 600 if unavailable else 0), payload)
        return payload
