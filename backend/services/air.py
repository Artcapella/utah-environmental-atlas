"""Chart-ready air-quality series for the environmental pages.

* ``station_history``: hourly PM2.5 (and the 24-hour average) at one Utah DAQ station,
  oldest first, for the trend chart.
* ``statewide_monitors``: the latest PM2.5 at every monitor in the DAQ XML feed, for the
  ranked "air across Utah" chart.

Both are small, read-only and cached in memory; the API routes also send CDN cache
headers so a serverless deployment does not re-fetch upstream on every page view.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from backend.models import Coordinate
from backend.providers import utah_daq

HISTORY_TTL_S = 600
MAX_HISTORY_HOURS = 240  # the feed is ~10-15 days deep

_cache: dict[str, tuple[float, Any]] = {}


async def _cached(key: str, ttl: int, fn: Callable[[], Awaitable[Any]]) -> Any:
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = await fn()
    _cache[key] = (time.time(), value)
    return value


def _station_payload(station: utah_daq.AirStation, distance_km: float | None) -> dict[str, Any]:
    return {
        "id": station.id,
        "name": station.name,
        "county": station.county,
        "elevation_m": station.elevation_m,
        "distance_km": None if distance_km is None else round(distance_km, 1),
        "lat": station.coordinate.lat,
        "lng": station.coordinate.lng,
        "source_url": utah_daq.FEED_URL.format(station_id=station.id),
    }


def _series(readings: list[Any], hours: int) -> list[dict[str, Any]]:
    """Oldest-first hourly points inside the window; hours with no PM2.5 at all are dropped."""
    if not readings:
        return []
    cutoff = readings[0].observed_at - timedelta(hours=hours)
    points = [
        {
            "t": reading.observed_at.isoformat(),
            "pm25": reading.pm25,
            "pm25_24h": reading.pm25_24hr_avg,
            "temp_f": reading.temp_f,
            "wind_mph": reading.wind_mph,
        }
        for reading in readings
        if reading.observed_at > cutoff and (reading.pm25 is not None or reading.pm25_24hr_avg is not None)
    ]
    points.reverse()
    return points


async def station_history(lat: float, lng: float, hours: int = 72, station_id: str | None = None) -> dict[str, Any]:
    """Hourly PM2.5 at ``station_id``, or at the nearest station with fresh data."""
    hours = max(6, min(hours, MAX_HISTORY_HOURS))
    if station_id:
        station = utah_daq.STATIONS_BY_ID.get(station_id)
        if station is None:
            raise LookupError(f"Unknown Utah DAQ station: {station_id}")
        distance = dict((s.id, d) for s, d in utah_daq.nearest_stations(Coordinate(lat=lat, lng=lng)))[station.id]
        readings = await _cached(f"daq:{station.id}", HISTORY_TTL_S, lambda: utah_daq.fetch_station_readings(station.id))
    else:
        point = Coordinate(lat=lat, lng=lng)

        async def nearest() -> tuple[Any, float, list[Any]]:
            return await utah_daq.fetch_nearest_readings(point)

        station, distance, readings = await _cached(
            f"daq-nearest:{round(lat, 2)}:{round(lng, 2)}", HISTORY_TTL_S, nearest
        )
    latest = utah_daq.latest_with_pm25(readings)
    aqi = category = None
    if latest is not None and latest.pm25_24hr_avg is not None:
        aqi, category = utah_daq.pm25_aqi(latest.pm25_24hr_avg)
    return {
        "station": _station_payload(station, distance),
        "hours": hours,
        "latest": None if latest is None else {
            "observed_at": latest.observed_at.isoformat(),
            "pm25": latest.pm25,
            "pm25_24h": latest.pm25_24hr_avg,
            "aqi": aqi,
            "category": category,
        },
        "points": _series(readings, hours),
        "stations": [
            {"id": s.id, "name": s.name, "county": s.county, "distance_km": round(d, 1),
             "lat": s.coordinate.lat, "lng": s.coordinate.lng}
            for s, d in utah_daq.nearest_stations(Coordinate(lat=lat, lng=lng))
        ],
        "note": "Hourly readings straight from the Utah DAQ feed; not quality-assured.",
    }


async def statewide_monitors() -> dict[str, Any]:
    """Latest PM2.5 at every monitor in the DAQ XML feed, highest first."""
    from backend.inversion import sources

    monitors = await sources.fetch_monitors()
    rows = sorted(({**m} for m in monitors), key=lambda m: m["pm25"], reverse=True)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "monitors": rows,
        "source_url": "https://air.utah.gov/",
        "note": "Latest hourly PM2.5 from the Utah DAQ XML feed; not quality-assured.",
    }
