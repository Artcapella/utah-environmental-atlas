"""Gemini environmental agent: function-calling RAG over the atlas's own live data.

Instead of stuffing a fixed source pack into the prompt, Gemini decides which
environmental tools to call (air quality, weather, inversion estimate, inversion
outlook, outdoor comfort, source search, geocoding). Every tool returns a source
label such as ``S2`` that the model must cite; the API then returns only the
citations the answer actually uses.

All Gemini traffic stays on the server. The key is sent only in the
``x-goog-api-key`` header and is never logged or returned to the browser.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

from backend.config import settings
from backend.guide.links import normalize_source_url
from backend.guide.planning import utah_now
from backend.guide.prompts import ENVIRONMENTAL_INSTRUCTIONS
from backend.guide.schemas import GuideAnswerRequest, GuideCitation
from backend.models import Coordinate

logger = logging.getLogger(__name__)

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
MAX_TOOL_ROUNDS = 5
MAX_CALLS_PER_ROUND = 6
TOOL_TIMEOUT_S = 20.0
REQUEST_TIMEOUT_S = 35.0
RETRYABLE_STATUS = {429, 500, 503, 504}
# A 429 asking us to wait longer than this is a quota (e.g. free-tier requests per day), not a
# momentary overload: retrying is pointless, so the model is benched until the delay passes.
QUOTA_DELAY_S = 60.0
MAX_BENCH_S = 6 * 3600.0
_benched_until: dict[str, float] = {}

# Utah's bounding box, matching GuideSearchRequest. Model-supplied coordinates are clamped to it.
LAT_RANGE = (36.0, 43.0)
LNG_RANGE = (-114.2, -109.0)
# Kept out of the environmental context even when the shared index returns them.
NON_ENVIRONMENTAL_TAGS = {"food", "art", "venue", "event", "event-calendar", "nightlife", "shopping"}

_POINT_PARAMS = {
    "type": "object",
    "properties": {
        "lat": {"type": "number", "description": "Latitude in Utah (36 to 43). Omit to use the visitor's map center."},
        "lng": {"type": "number", "description": "Longitude in Utah (-114.2 to -109). Omit to use the visitor's map center."},
    },
}

TOOL_DECLARATIONS: list[dict[str, Any]] = [
    {
        "name": "get_air_quality",
        "description": (
            "Latest PM2.5 from the nearest Utah DAQ air monitor: 24-hour average, EPA AQI and category, "
            "recent hourly trend, station name and distance, plus local temperature, humidity and wind."
        ),
        "parameters": _POINT_PARAMS,
    },
    {
        "name": "get_weather",
        "description": "Current National Weather Service hourly forecast period: temperature, sky, wind, humidity, precipitation chance.",
        "parameters": _POINT_PARAMS,
    },
    {
        "name": "get_inversion_status",
        "description": (
            "Today's estimated temperature inversion (smog lid) from nearby weather stations combined with PM2.5, "
            "a plain-language headline, and the nearest trailheads judged GO / CAUTION / SKIP for clean air."
        ),
        "parameters": _POINT_PARAMS,
    },
    {
        "name": "get_inversion_outlook",
        "description": "Seven-day inversion risk outlook (Low/Medium/High) from forecast 850 hPa warming and afternoon mixing height.",
        "parameters": _POINT_PARAMS,
    },
    {
        "name": "get_outdoor_comfort",
        "description": "Outdoor Comfort nowcast (good / caution / poor) with confidence and reasons, from air and weather readings.",
        "parameters": _POINT_PARAMS,
    },
    {
        "name": "search_environmental_sources",
        "description": (
            "Search the atlas's indexed sources (road, park and avalanche advisories; trailheads; parks; public lands) "
            "for documents relevant to a query."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to look for, e.g. 'avalanche advisory Little Cottonwood'."},
                "lat": _POINT_PARAMS["properties"]["lat"],
                "lng": _POINT_PARAMS["properties"]["lng"],
            },
            "required": ["query"],
        },
    },
    {
        "name": "geocode_address",
        "description": "Resolve a Utah street address to coordinates (US Census geocoder). For towns, use your own knowledge of coordinates.",
        "parameters": {
            "type": "object",
            "properties": {"address": {"type": "string", "description": "Street address including city and 'UT'."}},
            "required": ["address"],
        },
    },
]


@dataclass(slots=True)
class _Run:
    """Per-request state: the default point and the citations the tools have produced."""

    lat: float
    lng: float
    citations: list[GuideCitation] = field(default_factory=list)

    def cite(self, title: str, source_name: str, url: str | None, kind: str = "other", freshness: str | None = None) -> str:
        url = normalize_source_url(url, title=title)
        for citation in self.citations:
            if citation.title == title and citation.url == url:
                return citation.label or ""
        label = f"S{len(self.citations) + 1}"
        self.citations.append(GuideCitation(
            id=f"tool:{label}", label=label, title=title, url=url,
            source_name=source_name, kind=kind, freshness=freshness,  # type: ignore[arg-type]
        ))
        return label

    def point(self, args: dict[str, Any]) -> Coordinate:
        def clamp(value: Any, default: float, low: float, high: float) -> float:
            try:
                return min(max(float(value), low), high)
            except (TypeError, ValueError):
                return default
        return Coordinate(
            lat=clamp(args.get("lat"), self.lat, *LAT_RANGE),
            lng=clamp(args.get("lng"), self.lng, *LNG_RANGE),
        )


# ----------------------------------------------------------------------- tools

async def _tool_air_quality(run: _Run, args: dict[str, Any]) -> dict[str, Any]:
    from backend.providers.utah_daq import FEED_URL, fetch_nearest_readings, latest_with_pm25, pm25_aqi

    station, distance_km, readings = await fetch_nearest_readings(run.point(args))
    latest = latest_with_pm25(readings)
    if latest is None or latest.pm25_24hr_avg is None:
        return {"available": False, "reason": "no recent PM2.5 at nearby monitors"}
    aqi, category = pm25_aqi(latest.pm25_24hr_avg)
    label = run.cite(f"{station.name} air monitor", "Utah DAQ", FEED_URL.format(station_id=station.id),
                     "advisory", latest.observed_at.isoformat())
    trend = [
        {"observed_at": r.observed_at.isoformat(), "pm25": r.pm25}
        for r in readings[:6] if r.pm25 is not None
    ]
    return {
        "source_label": label,
        "station": station.name,
        "county": station.county,
        "station_elevation_m": station.elevation_m,
        "distance_km": round(distance_km, 1),
        "observed_at": latest.observed_at.isoformat(),
        "pm25_24hr_avg_ugm3": latest.pm25_24hr_avg,
        "pm25_latest_hour_ugm3": latest.pm25,
        "aqi": aqi,
        "aqi_category": category,
        "temperature_f": latest.temp_f,
        "relative_humidity": latest.humidity,
        "wind_mph": latest.wind_mph,
        "recent_hourly_pm25": trend,
    }


async def _tool_weather(run: _Run, args: dict[str, Any]) -> dict[str, Any]:
    from backend.providers.nws import _first_hourly_period

    point = run.point(args)
    period = await _first_hourly_period(point)
    label = run.cite("National Weather Service hourly forecast", "NWS",
                     f"https://forecast.weather.gov/MapClick.php?lat={point.lat:.4f}&lon={point.lng:.4f}", "advisory")

    def quantity(key: str) -> Any:
        return (period.get(key) or {}).get("value")

    return {
        "source_label": label,
        "starts_at": period.get("startTime"),
        "temperature": period.get("temperature"),
        "temperature_unit": period.get("temperatureUnit"),
        "short_forecast": period.get("shortForecast"),
        "wind": f"{period.get('windDirection', '')} {period.get('windSpeed', '')}".strip(),
        "relative_humidity_pct": quantity("relativeHumidity"),
        "precipitation_chance_pct": quantity("probabilityOfPrecipitation"),
    }


async def _tool_inversion_status(run: _Run, args: dict[str, Any]) -> dict[str, Any]:
    from backend.inversion import service as inversion_service

    point = run.point(args)
    today = await inversion_service.today("live", point.lat, point.lng)
    label = run.cite("Inversion estimate: weather-station temperature profile and PM2.5", "YOUtah inversion model",
                     "https://air.utah.gov", "advisory")
    trailheads = [
        {key: trailhead.get(key) for key in ("name", "elevation_m", "verdict", "why", "distance_km", "use")}
        for trailhead in today.get("trailheads", [])[:8]
    ]
    return {
        "source_label": label,
        "headline": today.get("headline"),
        "pm25": today.get("pm25"),
        "pm_level": today.get("pm_level"),
        "air_from": today.get("air_from"),
        "inversion": today.get("lid"),
        "station_source": today.get("source"),
        "trailhead_verdict_counts": today.get("counts"),
        "nearest_trailheads": trailheads,
        "in_wasatch_front": today.get("in_wasatch"),
        "disclaimer": today.get("disclaimer"),
    }


async def _tool_inversion_outlook(run: _Run, args: dict[str, Any]) -> dict[str, Any]:
    from backend.inversion import service as inversion_service

    point = run.point(args)
    days = await inversion_service.outlook(point.lat, point.lng)
    label = run.cite("Seven-day inversion outlook (Open-Meteo forecast)", "Open-Meteo",
                     "https://open-meteo.com", "advisory")
    return {
        "source_label": label,
        "days": days,
        "notes": "confidence 'forecast' for the first three days, 'trend' afterwards. Not an official forecast.",
    }


async def _tool_outdoor_comfort(run: _Run, args: dict[str, Any]) -> dict[str, Any]:
    from backend.intelligence.service import build_area_brief

    point = run.point(args)
    brief = await build_area_brief(point.lat, point.lng)
    comfort = brief.outdoor_comfort
    label = run.cite("Outdoor Comfort nowcast", "YOUtah intelligence model",
                     brief.source_urls.get("air_quality"), "advisory", brief.generated_at.isoformat())
    return {
        "source_label": label,
        "label": comfort.label,
        "confidence": comfort.confidence,
        "model_kind": comfort.model_kind,
        "horizon_hours": comfort.horizon_hours,
        "reasons": comfort.reasons,
        "air_station": brief.air_station.model_dump(mode="json"),
        "disclaimer": comfort.disclaimer,
    }


async def _tool_search_sources(run: _Run, args: dict[str, Any]) -> dict[str, Any]:
    # Imported lazily: service.py imports this module to route environmental requests.
    from backend.guide.service import retrieve

    query = str(args.get("query") or "").strip()[:300]
    if not query:
        return {"results": [], "reason": "empty query"}
    point = run.point(args)
    documents, mode = await retrieve(query, point.lat, point.lng, None)
    results = []
    for document in documents:
        tags = {tag.lower() for tag in document.tags}
        if document.entity_type == "event" or tags & NON_ENVIRONMENTAL_TAGS:
            continue
        label = run.cite(document.title, document.source_name, document.source_url,
                         document.entity_type if document.entity_type in {"place", "advisory", "story"} else "other",
                         document.freshness)
        results.append({
            "source_label": label,
            "title": document.title,
            "type": document.entity_type,
            "tags": document.tags[:8],
            "content": " ".join(document.content.split())[:900],
        })
    return {"retrieval": mode, "results": results[:6]}


async def _tool_geocode(run: _Run, args: dict[str, Any]) -> dict[str, Any]:
    from backend.inversion import sources as inversion_sources

    address = str(args.get("address") or "").strip()[:200]
    hit = await inversion_sources.geocode(address) if len(address) >= 3 else None
    if not hit:
        return {"found": False}
    return {"found": True, "lat": hit["lat"], "lng": hit["lon"], "matched_address": hit["address"]}


TOOLS: dict[str, Callable[[_Run, dict[str, Any]], Awaitable[dict[str, Any]]]] = {
    "get_air_quality": _tool_air_quality,
    "get_weather": _tool_weather,
    "get_inversion_status": _tool_inversion_status,
    "get_inversion_outlook": _tool_inversion_outlook,
    "get_outdoor_comfort": _tool_outdoor_comfort,
    "search_environmental_sources": _tool_search_sources,
    "geocode_address": _tool_geocode,
}


async def _execute(run: _Run, call: dict[str, Any]) -> dict[str, Any]:
    name = str(call.get("name") or "")
    tool = TOOLS.get(name)
    if tool is None:
        result: dict[str, Any] = {"error": f"unknown tool {name}"}
    else:
        try:
            result = await asyncio.wait_for(tool(run, dict(call.get("args") or {})), TOOL_TIMEOUT_S)
        except Exception as error:
            # Upstream outages become an honest "unavailable" the model can explain.
            logger.info("Environmental tool %s unavailable (%s)", name, type(error).__name__)
            result = {"available": False, "error": f"{name} is temporarily unavailable"}
    response: dict[str, Any] = {"name": name, "response": json.loads(json.dumps(result, default=str))}
    if call.get("id"):
        response["id"] = call["id"]
    return {"functionResponse": response}


# ---------------------------------------------------------------- gemini loop

async def _generate(client: httpx.AsyncClient, model: str, body: dict[str, Any]) -> dict[str, Any]:
    response = await client.post(
        f"{GEMINI_BASE_URL}/models/{model}:generateContent",
        headers={"x-goog-api-key": settings.gemini_api_key},
        json=body,
    )
    response.raise_for_status()
    return response.json()


def _retry_delay_s(response: httpx.Response) -> float | None:
    """The RetryInfo delay from a Google API error body ("46616s"), if any."""
    try:
        details = response.json().get("error", {}).get("details", [])
    except Exception:
        return None
    for detail in details:
        if str(detail.get("@type", "")).endswith("RetryInfo"):
            try:
                return float(str(detail.get("retryDelay", "")).rstrip("s"))
            except ValueError:
                return None
    return None


async def _generate_with_fallback(
    client: httpx.AsyncClient, models: list[str], contents: list[dict[str, Any]]
) -> tuple[str, dict[str, Any]] | None:
    """Retry an overloaded model once, then move to the next; None when every model is busy."""
    body = _request_body(contents)
    now = time.monotonic()
    available = [model for model in models if _benched_until.get(model, 0) <= now]
    for model in available:
        for attempt in range(2):
            try:
                return model, await _generate(client, model, body)
            except httpx.HTTPStatusError as error:
                status = error.response.status_code
                if status not in RETRYABLE_STATUS:
                    logger.info("Gemini model %s rejected the request (HTTP %s)", model, status)
                    raise
                delay = _retry_delay_s(error.response) if status == 429 else None
                if delay is not None and delay > QUOTA_DELAY_S:
                    bench = min(delay, MAX_BENCH_S)
                    _benched_until[model] = time.monotonic() + bench
                    logger.info("Gemini model %s quota exhausted; skipping it for %.0f s", model, bench)
                    break
                logger.info("Gemini model %s busy (HTTP %s), attempt %s", model, status, attempt + 1)
            except httpx.TimeoutException:
                # A slow model is unlikely to recover within this request; try the next one.
                logger.info("Gemini model %s timed out", model)
                break
            if attempt == 0:
                await asyncio.sleep(1.5)
    return None


def _request_body(contents: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "systemInstruction": {"parts": [{"text": ENVIRONMENTAL_INSTRUCTIONS}]},
        "contents": contents,
        "tools": [{"functionDeclarations": TOOL_DECLARATIONS}],
        "toolConfig": {"functionCallingConfig": {"mode": "AUTO"}},
        "generationConfig": {"maxOutputTokens": 2048, "temperature": 0.3},
    }


def _final_text(parts: list[dict[str, Any]]) -> str:
    text = "\n".join(str(part["text"]) for part in parts if part.get("text") and not part.get("thought")).strip()
    # The UI links single labels only: "[S2, S3]" becomes "[S2] [S3]".
    return re.sub(
        r"\[(S\d+(?:\s*[,;]\s*S\d+)+)\]",
        lambda match: " ".join(f"[{label}]" for label in re.findall(r"S\d+", match.group(1))),
        text,
    )


async def tools_only_answer(request: GuideAnswerRequest) -> tuple[str, list[GuideCitation]] | None:
    """Plain-language conditions summary straight from the tools, for when Gemini is unavailable.

    It does not pretend to answer the question; it says so and gives the live readings (with the
    same citations) that most environmental questions start from.
    """
    run = _Run(lat=request.lat, lng=request.lng)
    air_part, inversion_part = await asyncio.gather(
        _execute(run, {"name": "get_air_quality", "args": {}}),
        _execute(run, {"name": "get_inversion_status", "args": {}}),
    )
    air = air_part["functionResponse"]["response"]
    inversion = inversion_part["functionResponse"]["response"]
    lines: list[str] = []
    if air.get("aqi") is not None:
        lines.append(
            f"- **Air quality:** {air['aqi_category']} (AQI {air['aqi']}), 24-hour PM2.5 "
            f"{air['pm25_24hr_avg_ugm3']} µg/m³ at the {air['station']} monitor, {air['distance_km']} km away "
            f"[{air['source_label']}]."
        )
    lid = inversion.get("inversion") or {}
    if inversion.get("source_label"):
        if lid.get("has_inversion"):
            lines.append(
                f"- **Inversion:** estimated smog lid near {lid['lid_m']:,} m; air below it is trapped "
                f"[{inversion['source_label']}]."
            )
        elif lid.get("reason") and lid.get("reason") != "not enough stations":
            lines.append(f"- **Inversion:** none detected now ({lid['reason']}) [{inversion['source_label']}].")
        counts = inversion.get("trailhead_verdict_counts") or {}
        go = [t["name"] for t in inversion.get("nearest_trailheads") or [] if t.get("verdict") == "GO"][:3]
        if counts and go:
            lines.append(
                f"- **Clean-air hiking:** {counts.get('GO', 0)} nearby trailheads look clean, e.g. "
                f"{', '.join(go)} [{inversion['source_label']}]."
            )
    if not lines:
        return None
    text = (
        "The assistant is busy right now, so I can't answer your question in full. Here are the live "
        "readings for the map center:\n\n" + "\n".join(lines)
        + "\n\nInversion and trailhead verdicts are estimates, not official forecasts. Try again in a moment, "
        "or check air.utah.gov and weather.gov."
    )
    return text, run.citations


async def answer_environmental(request: GuideAnswerRequest) -> tuple[str, list[GuideCitation]] | None:
    """Run the tool loop. Returns None (caller falls back) when Gemini is unconfigured or unavailable."""
    if not settings.gemini_api_key:
        return None
    run = _Run(lat=request.lat, lng=request.lng)
    contents: list[dict[str, Any]] = [{
        "role": "user",
        "parts": [{"text": (
            f"Current Utah date and time: {utah_now().isoformat()} (America/Denver)\n"
            f"Visitor's map center (default tool location): {request.lat:.4f}, {request.lng:.4f}\n\n"
            f"Question: {request.query}"
        )}],
    }]
    model: str | None = None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(REQUEST_TIMEOUT_S)) as client:
            for _ in range(MAX_TOOL_ROUNDS + 1):
                # Thought signatures are model-specific, so a model is chosen once per conversation.
                result = await _generate_with_fallback(client, [model] if model else settings.gemini_models, contents)
                if result is None:
                    return None
                model, payload = result

                candidate = (payload.get("candidates") or [{}])[0]
                content = candidate.get("content") or {}
                parts = content.get("parts") or []
                calls = [part["functionCall"] for part in parts if part.get("functionCall")]
                if not calls:
                    text = _final_text(parts)
                    if not text or candidate.get("finishReason") not in {None, "STOP"}:
                        return None
                    return text, run.citations
                # Echo the model turn verbatim (it carries thought signatures), then the tool results.
                contents.append({"role": "model", "parts": parts})
                responses = list(await asyncio.gather(*(_execute(run, call) for call in calls[:MAX_CALLS_PER_ROUND])))
                # Every call needs a response; excess calls are answered without running them.
                for call in calls[MAX_CALLS_PER_ROUND:]:
                    skipped: dict[str, Any] = {"name": call.get("name"), "response": {"error": "too many calls this turn"}}
                    if call.get("id"):
                        skipped["id"] = call["id"]
                    responses.append({"functionResponse": skipped})
                contents.append({"role": "user", "parts": responses})
    except (httpx.HTTPError, KeyError, TypeError, ValueError) as error:
        # Never include request headers or bodies (they carry the key) in a log message.
        logger.info("Gemini environmental agent unavailable (%s)", type(error).__name__)
        return None
    logger.info("Gemini environmental agent exceeded %s tool rounds", MAX_TOOL_ROUNDS)
    return None
