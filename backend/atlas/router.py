"""Environmental Atlas API: the Impact Panel, legislative briefing and scenario overlays.

GET  /api/atlas/projects         registry (size options, published figures with source-type tags)
POST /api/atlas/impact           ranges per project and in total, by basin, lever log, factors
POST /api/atlas/overlays         GeoJSON: scenario project rings + illustrative playa band
POST /api/atlas/extract/project  Gemini: proposal text -> project fields, each with its quote
POST /api/atlas/extract/bill     Gemini: bill text -> closed lever list with quotes + "not modeled"
GET  /api/atlas/bills            bill library: real measures and mock bills mapped onto levers
POST /api/atlas/compare          four branches for one project: engine ranges + published figures by row
POST /api/atlas/ask              atlas assistant: RAG answer with citations + map actions
GET  /api/atlas/ask/status       which models and search mode the assistant has (no credentials)
"""
from __future__ import annotations

import json
from dataclasses import asdict
from functools import lru_cache
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.atlas import assistant, gemini as gb
from backend.atlas import overlays as ov
from backend.atlas.bills import list_bills
from backend.atlas.comparison import compare_branches
from backend.atlas.engine import BRANCHES, REGISTRY, REGISTRY_BY_ID, Levers, Project, rounded, run_scenario

router = APIRouter(prefix="/api/atlas", tags=["environmental-atlas"])

ROOT = Path(__file__).resolve().parents[2]
BUNDLED = Path(__file__).resolve().parent / "data"          # shipped with the Python function
PUBLIC = ROOT / "public" / "atlas" / "data"                 # local runs: also holds fetched layers
# Overlap flags read fetched layers (scripts/atlas/fetch_layers.py writes them to public/atlas/data).
# On Vercel public/ is not in the function bundle, so overlaps report "not loaded" there.
LAYERS = PUBLIC if PUBLIC.is_dir() else BUNDLED


class CustomProject(BaseModel):
    name: str = "Dropped project"
    county: str = "Unknown"
    lat: float = Field(ge=36.5, le=42.5)
    lon: float = Field(ge=-114.5, le=-108.5)
    mw: float = Field(gt=0, le=50_000)
    cooling: Optional[str] = None
    onsite_gas: Optional[bool] = None
    power_cooling: Optional[str] = None
    gsl_basin: bool = False
    footprint_acres: Optional[float] = None
    basin: str = "Unassigned"
    baseline_consumptive_af: Optional[float] = None


class ImpactRequest(BaseModel):
    project_ids: list[str] = []
    custom: list[CustomProject] = Field(default_factory=list, max_length=25)
    levers: dict = {}
    branch: str = "built"          # built | conditions | scaled | not_built
    scale: float = Field(1.0, gt=0, le=1.0)   # used when branch == "scaled"
    sizes: dict[str, float] = {}   # {project_id: mw}, e.g. a phase from size_options_mw
    explain: bool = False


class CompareRequest(BaseModel):
    project_id: str = "stratos"
    levers: dict = {}
    scaled_mw: Optional[float] = Field(None, gt=0, le=50_000)


class TextIn(BaseModel):
    text: str = Field(min_length=20, max_length=60_000)


def _run(req: ImpactRequest) -> dict:
    if req.branch not in BRANCHES:
        raise HTTPException(422, f"branch must be one of {list(BRANCHES)}")
    if req.custom and any(c.cooling not in (None, "evaporative", "closed_loop") or
                          c.power_cooling not in (None, "wet", "dry") for c in req.custom):
        raise HTTPException(422, "cooling must be evaporative|closed_loop; power_cooling wet|dry")
    custom = [Project(id=f"custom_{i}", **c.model_dump()) for i, c in enumerate(req.custom)]
    try:
        lv = Levers(**req.levers)
    except TypeError as e:
        raise HTTPException(422, f"unknown lever: {e}")
    return run_scenario(req.project_ids, custom, lv, LAYERS, branch=req.branch,
                        scale=req.scale, sizes=req.sizes or None)


@lru_cache(maxsize=1)
def _lake_geometry() -> dict | None:
    for folder in (BUNDLED, PUBLIC):
        ref = folder / "gsl_reference.geojson"
        if ref.exists():
            return json.loads(ref.read_text(encoding="utf-8"))["features"][0]["geometry"]
    return None


def _gemini_call(fn, *args):
    try:
        return fn(*args)
    except gb.GeminiUnavailable as e:
        raise HTTPException(503, str(e))


@router.get("/projects")
def list_projects() -> list[dict]:
    """Registry for the 'Proposed' tab and map markers."""
    return [asdict(p) for p in REGISTRY]


@router.post("/impact")
def impact(req: ImpactRequest) -> dict:
    result = rounded(_run(req))
    if req.explain:
        brief = {"branch": result["branch_label"], "totals": result["totals"], "lever_log": result["lever_log"],
                 "projects": [{k: p.get(k) for k in ("name", "water_af", "reporting_visible", "note")}
                              for p in result["projects"]]}
        try:
            result["summary"] = gb.explain(brief)
        except gb.GeminiUnavailable as e:
            result["summary"] = {"summary": None, "grounded": False, "error": str(e)}
    return result


@router.post("/overlays")
def overlays(req: ImpactRequest) -> dict:
    """Scenario overlays for the map: project points (with results) + illustrative playa band."""
    res = rounded(_run(req))
    reg = dict(REGISTRY_BY_ID)
    reg.update({f"custom_{i}": Project(id=f"custom_{i}", **c.model_dump()) for i, c in enumerate(req.custom)})
    out = {"projects": ov.projects_fc(res, reg), "playa": ov.fc([])}
    lake = _lake_geometry()
    acres = res["totals"]["gsl"]["playa_acres"][1]
    if lake and acres:
        pb = ov.playa_band(lake, acres)
        if pb:
            out["playa"] = ov.fc([ov.feature(pb["band"], {
                "illustrative": True, "branch": res["branch_label"], "playa_acres_central": acres,
                "level_drop_ft_central": res["totals"]["gsl"]["level_drop_ft"][1]})])
    return out


@router.post("/extract/project")
def extract_project(body: TextIn) -> dict:
    return _gemini_call(gb.extract_project, body.text).model_dump()


@router.post("/extract/bill")
def extract_bill(body: TextIn) -> dict:
    """Returns levers with quotes; the UI shows them for confirmation, then posts to /impact."""
    out = _gemini_call(gb.extract_bill, body.text).model_dump()
    levers = {}
    for lever in out["levers"]:
        try:
            levers[lever["lever"]] = json.loads(lever["value"])
        except json.JSONDecodeError:
            out["not_modeled"].append(f'{lever["lever"]}: could not parse "{lever["value"]}"')
    try:
        Levers(**levers)
    except TypeError as e:  # defensive: the schema already restricts lever names
        raise HTTPException(502, f"Gemini returned an unknown lever: {e}")
    out["levers_dict"] = levers
    return out


@router.get("/bills")
def bills() -> list[dict]:
    """Bill library for the Legislation tab; each bill carries its levers, map effect and source."""
    return list_bills()


@router.post("/compare")
def compare(req: CompareRequest) -> dict:
    """Four branches for one project. With no levers, 'with conditions' uses an example pair and says so."""
    try:
        return compare_branches(req.project_id, req.levers, req.scaled_mw)
    except KeyError:
        raise HTTPException(404, "unknown project id")
    except TypeError as e:
        raise HTTPException(422, f"unknown lever: {e}")


@router.post("/ask")
async def ask(req: assistant.AskRequest) -> dict:
    """Atlas assistant. Always answers: Gemini agent, then OpenAI, then quoted source passages."""
    return (await assistant.ask(req)).model_dump(mode="json")


@router.get("/ask/status")
def ask_status() -> dict:
    return assistant.status()
