"""FastAPI routes for the Impact Panel.

Drop into: backend/routes/atlas_impact.py, then in your app:
    from backend.routes.atlas_impact import router as impact_router
    app.include_router(impact_router)
Adjust the two relative imports below to your package layout.
"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .impact_engine import REGISTRY, Levers, Project, rounded, run_scenario
from . import gemini_bridge as gb

router = APIRouter(prefix="/api/atlas", tags=["atlas-impact"])
LAYERS = Path(__file__).resolve().parents[1] / "static" / "atlas"


class CustomProject(BaseModel):
    name: str = "Dropped project"
    county: str = "Unknown"
    lat: float
    lon: float
    mw: float
    cooling: Optional[str] = None
    onsite_gas: Optional[bool] = None
    power_cooling: Optional[str] = None
    gsl_basin: bool = False
    footprint_acres: Optional[float] = None


class ImpactRequest(BaseModel):
    project_ids: list[str] = []
    custom: list[CustomProject] = []
    levers: dict = {}
    explain: bool = False


@router.get("/projects")
def list_projects():
    """Registry for the 'Proposed' tab and map markers."""
    return [asdict(p) for p in REGISTRY]


@router.post("/impact")
def impact(req: ImpactRequest):
    custom = [Project(id=f"custom_{i}", **c.model_dump()) for i, c in enumerate(req.custom)]
    try:
        lv = Levers(**req.levers)
    except TypeError as e:
        raise HTTPException(422, f"unknown lever: {e}")
    result = rounded(run_scenario(req.project_ids, custom, lv, LAYERS))
    if req.explain:
        brief = {"totals": result["totals"], "lever_log": result["lever_log"],
                 "projects": [{k: p.get(k) for k in ("name", "water_af", "reporting_visible")}
                              for p in result["projects"]]}
        result["summary"] = gb.explain(brief)
    return result


class TextIn(BaseModel):
    text: str


@router.post("/extract/project")
def extract_project(body: TextIn):
    return gb.extract_project(body.text).model_dump()


@router.post("/extract/bill")
def extract_bill(body: TextIn):
    """Returns levers with quotes; the UI shows them for confirmation, then posts to /impact."""
    out = gb.extract_bill(body.text).model_dump()
    levers = {}
    for l in out["levers"]:
        try:
            levers[l["lever"]] = json.loads(l["value"])
        except json.JSONDecodeError:
            out["not_modeled"].append(f'{l["lever"]}: could not parse "{l["value"]}"')
    out["levers_dict"] = levers
    return out
