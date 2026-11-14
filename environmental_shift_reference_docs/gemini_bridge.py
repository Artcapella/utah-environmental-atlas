"""Gemini bridge: extraction (text -> structured fields) and grounded explanation.

Drop into: backend/intelligence/gemini_bridge.py
pip install google-genai pydantic
Env: GEMINI_API_KEY, optional GEMINI_MODEL (defaults to a Flash-tier model).
"""
from __future__ import annotations

import json
import os
import re
from typing import Literal, Optional

from pydantic import BaseModel, Field

MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")


# ---------------------------------------------------------------- schemas
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
    quotes: dict[str, str] = Field(default_factory=dict,
                                   description="field name -> exact sentence it came from")


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
    not_modeled: list[str] = Field(default_factory=list,
                                   description="Quoted provisions that match no lever")


EXTRACT_PROJECT = """Extract fields describing a proposed development in Utah.
Use ONLY facts stated in the text. Leave a field null if not stated. Do not estimate.
For every non-null field, put the exact supporting sentence in `quotes`.

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
- No recommendations or opinions.

JSON:
{payload}"""


def _client():
    from google import genai
    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])


def _structured(prompt: str, schema):
    from google.genai import types
    resp = _client().models.generate_content(
        model=MODEL, contents=prompt,
        config=types.GenerateContentConfig(response_mime_type="application/json",
                                           response_schema=schema, temperature=0))
    return resp.parsed


def extract_project(text: str) -> ProjectExtract:
    return _structured(EXTRACT_PROJECT.format(text=text[:30_000]), ProjectExtract)


def extract_bill(text: str) -> BillExtract:
    return _structured(EXTRACT_BILL.format(text=text[:60_000]), BillExtract)


# ---------------------------------------------------------------- number guard
_NUM = re.compile(r"(?<![\w.])-?\d[\d,]*(?:\.\d+)?")


def _numbers(obj) -> list[float]:
    s = json.dumps(obj)
    return [float(m.replace(",", "")) for m in _NUM.findall(s)]


def ungrounded_numbers(text: str, payload: dict, tol: float = 0.01) -> list[str]:
    """Numbers in `text` that don't match (within 1%) any number in `payload`. Allows 0-10."""
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
    for attempt in range(retries + 1):
        text = _client().models.generate_content(model=MODEL, contents=prompt).text.strip()
        bad = ungrounded_numbers(text, payload)
        if not bad:
            return {"summary": text, "grounded": True}
        prompt += f"\n\nYour previous answer used numbers not in the JSON: {bad}. Remove them."
    return {"summary": None, "grounded": False, "rejected_numbers": bad}
