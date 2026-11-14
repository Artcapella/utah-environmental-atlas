"""Environmental Atlas: impact engine, number guard, overlays and /api/atlas routes."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from fastapi import FastAPI

from backend.atlas.engine import (BRANCHES, REGISTRY, Levers, Project,
                                  project_impacts, rounded, run_scenario)
from backend.atlas.gemini import ungrounded_numbers
from backend.atlas import overlays as ov
from backend.atlas.router import router

ROOT = Path(__file__).resolve().parents[1]
ALL = [p.id for p in REGISTRY]


def test_100mw_it_evaporative_scale():
    # 100 MW IT at LF 0.8, WUE 1.8 -> ~1,020 AF/yr (design doc sanity check)
    p = Project("t", "t", "Salt Lake", 40.7, -111.9, 130, cooling="evaporative", onsite_gas=False)
    assert rounded(project_impacts(p, Levers())["water_af"]["site"][1]) == pytest.approx(1000, rel=0.05)


def test_stratos_central_matches_doc():
    r = rounded(run_scenario(["stratos"]))
    assert r["totals"]["water_af"][1] == 40000
    assert r["totals"]["gsl"]["level_drop_ft"][1] == 0.4


def test_ranges_ordered():
    for p in run_scenario(ALL)["projects"]:
        lo, c, hi = p["water_af"]["total"]
        assert lo <= c <= hi


def test_branches():
    res = {b: run_scenario(["stratos"], levers=Levers(power_cooling_required="dry"), branch=b, scale=0.5)
           for b in BRANCHES}
    assert res["not_built"]["totals"]["water_af"] == (0, 0, 0)
    assert "unknown, not zero" in res["not_built"]["projects"][0]["note"]
    assert res["conditions"]["totals"]["water_af"][1] < res["built"]["totals"]["water_af"][1]
    # "built" ignores design-condition levers
    assert res["built"]["totals"]["water_af"] == run_scenario(["stratos"])["totals"]["water_af"]


def test_eo_test_needs_baseline():
    r = run_scenario(["stratos"])["projects"][0]["water_af"]
    assert r["eo_2026_03_test"].startswith("Cannot test")
    p = Project("t", "t", "X", 40, -112, 100, cooling="closed_loop", onsite_gas=False, baseline_consumptive_af=5000)
    assert project_impacts(p, Levers())["water_af"]["eo_2026_03_test"].startswith("Central estimate does not")


def test_figures_carry_source_types():
    figs = run_scenario(["stratos"])["projects"][0]["water_af"]["figures"]
    assert {t for f in figs for t in f["source_types"]} >= {"dev", "gov", "adv", "ind"}


def test_moratorium_removes():
    r = run_scenario(ALL, levers=Levers(moratorium_counties=["Iron"]), branch="conditions")
    assert not {"antelope", "red_butte"} & {p["project"] for p in r["projects"]}


def test_number_guard():
    payload = {"x": 40000, "y": [0, 230000]}
    assert ungrounded_numbers("about 40,000 (range 0 to 230,000)", payload) == []
    assert ungrounded_numbers("about 39,000", payload) == ["39,000"]


def test_playa_band_area():
    lake = json.loads((ROOT / "backend/atlas/data/gsl_reference.geojson").read_text())["features"][0]["geometry"]
    pb = ov.playa_band(lake, 12_000)
    import math
    from shapely.ops import transform
    c = pb["band"].centroid
    k = 111_320 * math.cos(math.radians(c.y))
    acres = transform(lambda x, y, z=None: (x * k, y * 110_540), pb["band"]).area / 4046.86
    assert acres == pytest.approx(12_000, rel=0.05)


def test_api_routes():
    app = FastAPI()
    app.include_router(router)
    c = TestClient(app)
    assert len(c.get("/api/atlas/projects").json()) == len(REGISTRY)
    r = c.post("/api/atlas/impact", json={"project_ids": ["stratos"], "branch": "scaled", "scale": 0.5})
    assert r.status_code == 200 and r.json()["branch"] == "scaled"
    assert c.post("/api/atlas/impact", json={"branch": "nope"}).status_code == 422
    o = c.post("/api/atlas/overlays", json={"project_ids": ALL}).json()
    assert o["projects"]["features"] and o["playa"]["features"]


def test_custom_project_validation_and_gemini_503(monkeypatch):
    from backend.config import settings
    app = FastAPI()
    app.include_router(router)
    c = TestClient(app)
    drop = {"name": "Test", "lat": 40.5, "lon": -112.0, "mw": 300, "cooling": "evaporative", "onsite_gas": False, "gsl_basin": True}
    r = c.post("/api/atlas/impact", json={"custom": [drop]}).json()
    assert r["projects"][0]["water_af"]["total"][1] > 0 and r["totals"]["gsl"]["level_drop_ft"][1] > 0
    assert c.post("/api/atlas/impact", json={"custom": [{**drop, "cooling": "magic"}]}).status_code == 422
    assert c.post("/api/atlas/impact", json={"custom": [{**drop, "lat": 10}]}).status_code == 422
    monkeypatch.setattr(settings, "gemini_api_key", "")
    assert c.post("/api/atlas/extract/bill", json={"text": "A bill requiring closed-loop cooling for data centers."}).status_code == 503
    summary = c.post("/api/atlas/impact", json={"project_ids": ["stratos"], "explain": True}).json()["summary"]
    assert summary["summary"] is None and "not configured" in summary["error"]


def test_extract_bill_parses_levers(monkeypatch):
    from backend.atlas import gemini as gb
    fake = gb.BillExtract(bill_id="X", levers=[
        gb.LeverExtract(lever="cooling_required", value='"closed_loop"', quote="shall use closed-loop cooling"),
        gb.LeverExtract(lever="reporting_threshold_af", value="seventy-five", quote="75 acre-feet")])
    monkeypatch.setattr(gb, "extract_bill", lambda text: fake)
    app = FastAPI()
    app.include_router(router)
    out = TestClient(app).post("/api/atlas/extract/bill", json={"text": "x" * 40}).json()
    assert out["levers_dict"] == {"cooling_required": "closed_loop"}
    assert any("reporting_threshold_af" in n for n in out["not_modeled"])


def test_explain_rejects_ungrounded_numbers(monkeypatch):
    from backend.atlas import gemini as gb
    replies = iter(["About 39,000 acre-feet.", "Still 12,345."])
    monkeypatch.setattr(gb, "_generate", lambda prompt, cfg: next(replies))
    out = gb.explain({"water": [0, 40000, 230000]})
    assert out == {"summary": None, "grounded": False, "rejected_numbers": ["12,345"]}


def test_static_layers_match_engine():
    """public/atlas/data/projects.geojson is built from the engine; rebuild it after registry edits."""
    fc = json.loads((ROOT / "public/atlas/data/projects.geojson").read_text())
    ids = {f["properties"]["id"] for f in fc["features"]}
    assert ids == {p.id for p in REGISTRY}
    totals = rounded(run_scenario(ALL)["totals"])
    stratos = next(f for f in fc["features"] if f["properties"]["id"] == "stratos")["properties"]
    assert stratos["water_central"] == rounded(run_scenario(["stratos"]))["totals"]["water_af"][1]
    assert totals["water_af"][1] == json.loads((ROOT / "public/atlas/data/scenario_totals.json").read_text())["all_built"]["water_af"][1]
