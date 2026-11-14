"""Gemini bridge for the Environmental Atlas: extraction (text -> fields) and grounded explanation.

Gemini never produces impact numbers. It (1) maps proposal or bill text onto engine fields and
levers, quoting the sentence each value came from, and (2) narrates engine output, guarded by
`ungrounded_numbers`: any number not present in the engine payload rejects the summary.

Calls the Gemini REST API with the app's key (settings.gemini_api_key, sent as the
x-goog-api-key header, never logged) and walks settings.gemini_models on transient failures.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Literal, Optional

import httpx
from pydantic import BaseModel, Field, ValidationError

from backend.config import settings

logger = logging.getLogger(__name__)
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class GeminiUnavailable(RuntimeError):
    """No key configured, or every model failed. Routes turn this into HTTP 503."""


# ---------------------------------------------------------------- schemas
class Quote(BaseModel):
    field: str
    quote: str = Field(description="Exact sentence from the text that supports the field")


class ProjectExtract(BaseModel):
    name: Optional[str] = None
    county: Optional[str] = None
    mw: Optional[float] = Field(None, description="Announced facility power in MW (convert GW x1000)")
    cooling: Optional[Literal["evaporative", "closed_loop"]] = None
    onsite_gas: Optional[bool] = None
    power_cooling: Optional[Literal["wet", "dry"]] = None
    stated_af: Optional[float] = Field(None, description="Developer-stated annual water use, acre-feet")
    rights_af: Optional[float] = Field(None, description="Water rights held or sought, acre-feet")
    footprint_acres: Optional[float] = None
    quotes: list[Quote] = Field(default_factory=list, description="One entry per non-null field")


LeverName = Literal["cooling_required", "max_wue", "onsite_gas_allowed", "power_cooling_required",
                    "gsl_offset_ratio", "moratorium_counties", "habitat_setback_km",
                    "reporting_threshold_af"]


class LeverExtract(BaseModel):
    lever: LeverName
    value: str = Field(description="JSON-encoded value, e.g. '\"closed_loop\"', 'false', '75', '[\"Iron\"]'")
    quote: str


class BillExtract(BaseModel):
    bill_id: Optional[str] = None
    title: Optional[str] = None
    levers: list[LeverExtract] = Field(default_factory=list)
    not_modeled: list[str] = Field(default_factory=list, description="Quoted provisions that match no lever")


EXTRACT_PROJECT = """Extract fields describing a proposed development in Utah.
Use ONLY facts stated in the text. Leave a field null if not stated. Do not estimate.
For every non-null field, add an entry to `quotes` with the field name and the exact supporting sentence.

TEXT:
{text}"""

EXTRACT_BILL = """You map legislation onto a fixed list of model levers.
Levers: cooling_required (closed_loop|any), max_wue (L/kWh), onsite_gas_allowed (bool),
power_cooling_required (dry|any), gsl_offset_ratio (acre-feet delivered to Great Salt Lake per
acre-foot consumed), moratorium_counties (list of county names), habitat_setback_km (km),
reporting_threshold_af (acre-feet/yr that triggers reporting; reporting does NOT change use).
Only emit a lever if the bill text clearly requires it; quote the sentence.
Put every other substantive provision in not_modeled as a short quote.

BILL TEXT:
{text}"""

EXPLAIN = """Explain this environmental impact estimate to Utah residents and legislators
in 3-4 plain sentences. Rules:
- Use ONLY numbers that appear in the JSON below; round nothing further; invent nothing.
- Always give ranges as "about X (range A to B)".
- Mention when developer-stated use is far below the computed range.
- If a lever only changes reporting, say it changes what the state knows, not water use.
- Say "would" and "estimate", never "will" or "threat". No recommendations or opinions.

JSON:
{payload}"""


# ---------------------------------------------------------------- transport
def _generate(prompt: str, generation_config: dict) -> str:
    if not settings.gemini_api_key:
        raise GeminiUnavailable("Gemini is not configured (set GEMINI_API_KEY).")
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": generation_config}
    last: Exception | None = None
    with httpx.Client(timeout=httpx.Timeout(45.0)) as client:
        for model in settings.gemini_models:
            try:
                r = client.post(f"{GEMINI_BASE_URL}/models/{model}:generateContent",
                                headers={"x-goog-api-key": settings.gemini_api_key}, json=body)
                r.raise_for_status()
                parts = r.json()["candidates"][0]["content"]["parts"]
                return "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
            except httpx.HTTPStatusError as e:
                last = e
                logger.info("Atlas: Gemini model %s returned HTTP %s", model, e.response.status_code)
                if e.response.status_code not in RETRYABLE_STATUS:
                    break
            except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as e:
                last = e
                logger.info("Atlas: Gemini model %s failed: %s", model, type(e).__name__)
    raise GeminiUnavailable(f"Gemini request failed ({type(last).__name__ if last else 'no model'}).")


def _structured(prompt: str, schema: type[BaseModel]) -> BaseModel:
    text = _generate(prompt, {"temperature": 0, "responseMimeType": "application/json",
                              "responseJsonSchema": schema.model_json_schema()})
    try:
        return schema.model_validate_json(text)
    except ValidationError as e:
        raise GeminiUnavailable(f"Gemini returned data that does not match the schema: {e.error_count()} error(s).")


def extract_project(text: str) -> ProjectExtract:
    return _structured(EXTRACT_PROJECT.format(text=text[:30_000]), ProjectExtract)


def extract_bill(text: str) -> BillExtract:
    return _structured(EXTRACT_BILL.format(text=text[:60_000]), BillExtract)


# ---------------------------------------------------------------- number guard
_NUM = re.compile(r"(?<![\w.])-?\d[\d,]*(?:\.\d+)?")


def _numbers(obj) -> list[float]:
    return [float(m.replace(",", "")) for m in _NUM.findall(json.dumps(obj))]


def ungrounded_numbers(text: str, payload: dict, tol: float = 0.01) -> list[str]:
    """Numbers in `text` that don't match (within 1%) any number in `payload`. Allows integers 0-10."""
    allowed = _numbers(payload)
    bad = []
    for raw in _NUM.findall(text):
        v = float(raw.replace(",", ""))
        if abs(v) <= 10 and v == int(v):
            continue
        if not any(abs(v - a) <= tol * max(abs(a), 1e-9) for a in allowed):
            bad.append(raw)
    return bad


def explain(payload: dict, retries: int = 1) -> dict:
    prompt = EXPLAIN.format(payload=json.dumps(payload))
    bad: list[str] = []
    for _ in range(retries + 1):
        text = _generate(prompt, {"temperature": 0.2, "maxOutputTokens": 600})
        bad = ungrounded_numbers(text, payload)
        if not bad:
            return {"summary": text, "grounded": True}
        prompt += f"\n\nYour previous answer used numbers not in the JSON: {bad}. Remove them."
    return {"summary": None, "grounded": False, "rejected_numbers": bad}
