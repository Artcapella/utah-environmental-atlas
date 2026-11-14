"""Environmental chart/overlay data endpoints, alert outlines, deploy packaging, and Gemini resilience. Offline."""

import asyncio
import fnmatch
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from app import app
from backend.config import settings
from backend.guide import environmental, service
from backend.guide.schemas import GuideAnswerRequest
from backend.models import AirStationReading
from backend.services import air, alerts

ROOT = Path(__file__).resolve().parents[1]


def _readings(station_id: str, hours: int) -> list[AirStationReading]:
    now = datetime(2026, 11, 14, 17, tzinfo=timezone.utc)
    return [
        AirStationReading(station_id=station_id, observed_at=now - timedelta(hours=h),
                          pm25=None if h == 3 else float(h), pm25_24hr_avg=5.0)
        for h in range(hours)  # newest first, like the feed
    ]


def test_history_is_oldest_first_and_windowed(monkeypatch) -> None:
    air._cache.clear()

    async def fake_fetch(station_id, client=None):
        return _readings(station_id, 100)

    monkeypatch.setattr(air.utah_daq, "fetch_station_readings", fake_fetch)
    payload = asyncio.run(air.station_history(40.76, -111.89, hours=24, station_id="slc"))
    times = [p["t"] for p in payload["points"]]
    assert times == sorted(times) and len(times) == 24
    assert payload["station"]["name"] == "Hawthorne"
    assert payload["latest"]["aqi"] is not None
    # an hour with only a 24-h average is kept (the series has a gap, not a hole in time)
    assert any(p["pm25"] is None and p["pm25_24h"] == 5.0 for p in payload["points"])


def test_history_route_rejects_unknown_station_and_sets_cdn_cache(monkeypatch) -> None:
    air._cache.clear()

    async def fake_fetch(station_id, client=None):
        return _readings(station_id, 30)

    monkeypatch.setattr(air.utah_daq, "fetch_station_readings", fake_fetch)
    client = TestClient(app)
    assert client.get("/api/air/history?station=zz").status_code == 404
    ok = client.get("/api/air/history?station=slc&hours=12")
    assert ok.status_code == 200
    assert "s-maxage" in ok.headers["cache-control"]


def test_monitors_are_ranked_and_an_empty_feed_is_not_edge_cached(monkeypatch) -> None:
    async def some():
        return [{"name": "A", "lat": 40, "lon": -111, "pm25": 2.0}, {"name": "B", "lat": 40, "lon": -111, "pm25": 9.5}]

    async def none():
        return []

    client = TestClient(app)
    monkeypatch.setattr("backend.inversion.sources.fetch_monitors", some)
    ranked = client.get("/api/air/monitors")
    assert [m["name"] for m in ranked.json()["monitors"]] == ["B", "A"]
    assert "s-maxage" in ranked.headers["cache-control"]
    monkeypatch.setattr("backend.inversion.sources.fetch_monitors", none)
    assert "cache-control" not in client.get("/api/air/monitors").headers


def test_zone_based_alerts_get_merged_outlines(monkeypatch) -> None:
    alerts._alerts_cache = None
    alerts._zone_cache.clear()
    square = [[[-112.0, 40.0], [-111.0, 40.0], [-111.0, 41.0], [-112.0, 41.0], [-112.0, 40.0]]]
    responses = {
        "https://api.weather.gov/alerts/active": {"features": [
            {"geometry": None, "properties": {"id": "a1", "event": "Air Quality Alert", "severity": "Moderate",
                                              "affectedZones": ["https://api.weather.gov/zones/forecast/UTZ105",
                                                                "https://api.weather.gov/zones/forecast/UTZ106"]}},
            {"geometry": None, "properties": {"id": "a2", "event": "Mystery", "affectedZones": []}},
        ]},
        "https://api.weather.gov/zones/forecast/UTZ105": {"geometry": {"type": "Polygon", "coordinates": square}},
        "https://api.weather.gov/zones/forecast/UTZ106": {"geometry": {"type": "MultiPolygon", "coordinates": [square]}},
    }

    async def fake_get(self, url, params=None, **kwargs):
        return httpx.Response(200, json=responses[url], request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    payload = asyncio.run(alerts.utah_alerts())
    assert len(payload["features"]) == 1
    feature = payload["features"][0]
    assert feature["properties"]["event"] == "Air Quality Alert"
    assert feature["geometry"]["type"] == "MultiPolygon" and len(feature["geometry"]["coordinates"]) == 2
    assert [a["event"] for a in payload["unmapped"]] == ["Mystery"]
    alerts._alerts_cache = None


def test_ring_thinning_keeps_rings_closed() -> None:
    ring = [[-112 + i * 0.0001, 40.0] for i in range(200)] + [[-111.9, 40.1], [-112.0, 40.0]]
    thinned = alerts._round_ring(ring)
    assert len(thinned) < 20
    assert thinned[0] == thinned[-1]


def _vercelignore_excludes(path: str) -> bool:
    """gitignore semantics, enough for this file: '/x' is anchored, a bare name matches at any depth."""
    excluded = False
    for raw in (ROOT / ".vercelignore").read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        negate, pattern = line.startswith("!"), line.lstrip("!").rstrip("/")
        parts = path.split("/")
        if pattern.startswith("/"):
            anchored = pattern[1:]
            hit = path == anchored or path.startswith(anchored + "/") or fnmatch.fnmatch(path, anchored)
        elif "/" in pattern.lstrip("*/"):
            hit = fnmatch.fnmatch(path, pattern.lstrip("/")) or fnmatch.fnmatch(path, "*/" + pattern.lstrip("*/"))
        else:
            name = pattern.lstrip("*/")
            hit = any(fnmatch.fnmatch(part, name) for part in parts)
        if hit:
            excluded = not negate
    return excluded


def test_cli_deploys_keep_every_runtime_file() -> None:
    for path in ("app.py", "backend/intelligence/router.py", "backend/inversion/data/trailheads_elev.csv",
                 "backend/inversion/data/nws_ut_stations.json", "backend/intelligence/artifacts/outdoor_comfort.json",
                 "public/assets/map-climate.js", "pyproject.toml"):
        assert (ROOT / path).exists(), path
        assert not _vercelignore_excludes(path), path
    for path in ("data/utah_air_history.csv", ".env.local", "environmental_shift_reference_docs/router.py"):
        assert _vercelignore_excludes(path), path


def test_map_climate_layers_hook_into_the_map_core() -> None:
    html = (ROOT / "public" / "map.html").read_text(encoding="utf-8")
    # plug-in hooks the climate module relies on
    for hook in ("addLayer(def)", "onTime(fn)", "onDetail(fn)", "if (L.apply) { L.apply(on); return; }",
                 "for (const fn of HOOKS.time) fn(state.t);", "if (it.geometry) return"):
        assert hook in html, hook
    # environmental mode never shows the sample alert polygons as if they were real
    assert "if (ENV_MODE) { DATA.alerts = [];" in html
    script = (ROOT / "public" / "assets" / "map-climate.js").read_text(encoding="utf-8")
    for layer in ('id: "f-pm"', 'id: "f-temp"', 'id: "f-mix"', 'id: "f-wind"', 'id: "f-anom"'):
        assert layer in script, layer
    assert "/api/climate/grid" in script and "/api/alerts" in script and "/api/air/history" in script


def test_climate_grid_is_compact_and_cached(monkeypatch) -> None:
    from backend.services import climate

    climate._cache = None
    lats, lons = climate.grid_axes()
    hours = [f"2026-11-14T{h:02d}:00" for h in range(24)] + [f"2026-11-15T{h:02d}:00" for h in range(24)] \
        + [f"2026-11-16T{h:02d}:00" for h in range(24)] + [f"2026-11-17T{h:02d}:00" for h in range(24)]
    calls = []

    def location(variables):
        return {"hourly": {"time": hours, **{v: [float(i) for i in range(len(hours))] for v in variables}}}

    async def fake_get(self, url, params=None, **kwargs):
        calls.append(url)
        variables = params["hourly"].split(",")
        body = [location(variables) for _ in range(len(lats) * len(lons))]
        return httpx.Response(200, json=body, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    class FixedNow(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 11, 14, 19, 40, tzinfo=timezone.utc)

    monkeypatch.setattr(climate, "datetime", FixedNow)
    payload = asyncio.run(climate.climate_grid())
    assert set(payload["fields"]) == {"temp_f", "wind_mph", "wind_dir", "mix_m", "pm25", "aqi"}
    assert len(payload["times"]) == 25 and payload["times"][0].startswith("2026-11-14T19:00")
    assert len(payload["fields"]["temp_f"][0]) == len(lats) * len(lons)
    assert payload["fields"]["temp_f"][1][0] == 22  # 19:00 + 3 h -> hour index 22
    asyncio.run(climate.climate_grid())
    assert len(calls) == 2  # second call served from cache
    climate._cache = None


def test_quota_exhausted_model_is_benched_not_retried(monkeypatch) -> None:
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "gemini_model", "primary")
    monkeypatch.setattr(settings, "gemini_fallback_models_raw", "backup")
    monkeypatch.setattr(environmental, "_benched_until", {})
    called = []

    async def fake_generate(client, model, body):
        called.append(model)
        if model == "primary":
            request = httpx.Request("POST", "https://example.test")
            body = {"error": {"details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "46616s"}]}}
            raise httpx.HTTPStatusError("quota", request=request, response=httpx.Response(429, json=body, request=request))
        return {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "Clean air."}]}}]}

    monkeypatch.setattr(environmental, "_generate", fake_generate)
    ask = GuideAnswerRequest(query="air?", mode="environmental")
    assert asyncio.run(environmental.answer_environmental(ask)) == ("Clean air.", [])
    assert asyncio.run(environmental.answer_environmental(ask)) == ("Clean air.", [])
    assert called == ["primary", "backup", "backup"]  # no retry, and skipped on the next question


def test_unavailable_gemini_answers_from_live_tools(monkeypatch) -> None:
    monkeypatch.setattr(settings, "gemini_api_key", "")

    async def fake_air(run, args):
        label = run.cite("Hawthorne air monitor", "Utah DAQ", "https://air.utah.gov/csvFeed.php?id=slc", "advisory")
        return {"source_label": label, "aqi": 17, "aqi_category": "Good", "pm25_24hr_avg_ugm3": 3.0,
                "station": "Hawthorne", "distance_km": 3.4}

    async def fake_inversion(run, args):
        label = run.cite("Inversion estimate", "YOUtah inversion model", "https://air.utah.gov", "advisory")
        return {"source_label": label, "inversion": {"has_inversion": True, "lid_m": 1850},
                "trailhead_verdict_counts": {"GO": 12}, "nearest_trailheads": [{"name": "Ensign Peak", "verdict": "GO"}]}

    monkeypatch.setitem(environmental.TOOLS, "get_air_quality", fake_air)
    monkeypatch.setitem(environmental.TOOLS, "get_inversion_status", fake_inversion)
    response = asyncio.run(service.answer_guide(GuideAnswerRequest(query="Is it smoggy?", mode="environmental")))
    assert response.agent == "local_fallback" and response.retrieval == "tools"
    assert "AQI 17" in response.answer and "1,850 m" in response.answer and "Ensign Peak" in response.answer
    assert [c.label for c in response.citations] == ["S1", "S2"]
