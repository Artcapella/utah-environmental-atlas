"""FastAPI routes for the Impact Panel, briefing view and scenario overlays.

In your app:
    from backend.routes.atlas_impact import router as impact_router
    app.include_router(impact_router)
"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.intelligence.impact_engine import (BRANCHES, REGISTRY, REGISTRY_BY_ID, Levers,
                                                Project, rounded, run_scenario)
from backend.intelligence import gemini_bridge as gb
from backend.intelligence import overlays as ov

router = APIRouter(prefix="/api/atlas", tags=["atlas-impact"])
LAYERS = Path(__file__).resolve().parents[2] / "static" / "atlas"


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
    basin: str = "Unassigned"
    baseline_consumptive_af: Optional[float] = None


class ImpactRequest(BaseModel):
    project_ids: list[str] = []
    custom: list[CustomProject] = []
    levers: dict = {}
    branch: str = "built"          # built | conditions | scaled | not_built
    scale: float = 1.0             # used when branch == "scaled"
    sizes: dict[str, float] = {}   # {project_id: mw}, e.g. a phase from size_options_mw
    explain: bool = False


def _run(req: ImpactRequest) -> dict:
    if req.branch not in BRANCHES:
        raise HTTPException(422, f"branch must be one of {list(BRANCHES)}")
    custom = [Project(id=f"custom_{i}", **c.model_dump()) for i, c in enumerate(req.custom)]
    try:
        lv = Levers(**req.levers)
    except TypeError as e:
        raise HTTPException(422, f"unknown lever: {e}")
    return run_scenario(req.project_ids, custom, lv, LAYERS, branch=req.branch,
                        scale=req.scale, sizes=req.sizes or None)


@router.get("/projects")
def list_projects():
    """Registry for the 'Proposed' tab and map markers."""
    return [asdict(p) for p in REGISTRY]


@router.post("/impact")
def impact(req: ImpactRequest):
    result = rounded(_run(req))
    if req.explain:
        brief = {"totals": result["totals"], "lever_log": result["lever_log"],
                 "projects": [{k: p.get(k) for k in ("name", "water_af", "reporting_visible")}
                              for p in result["projects"]]}
        result["summary"] = gb.explain(brief)
    return result


@router.post("/overlays")
def overlays(req: ImpactRequest):
    """Scenario overlays for the map: project points (with results) + illustrative playa band."""
    res = rounded(_run(req))
    reg = dict(REGISTRY_BY_ID)
    reg.update({f"custom_{i}": Project(id=f"custom_{i}", **c.model_dump()) for i, c in enumerate(req.custom)})
    out = {"projects": ov.projects_fc(res, reg), "playa": ov.fc([])}
    ref = LAYERS / "gsl_reference.geojson"
    if ref.exists():
        lake = json.loads(ref.read_text())["features"][0]["geometry"]
        pb = ov.playa_band(lake, res["totals"]["gsl"]["playa_acres"][1])
        if pb:
            out["playa"] = ov.fc([ov.feature(pb["band"], {"illustrative": True,
                                  "playa_acres_central": res["totals"]["gsl"]["playa_acres"][1]})])
    return out


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
