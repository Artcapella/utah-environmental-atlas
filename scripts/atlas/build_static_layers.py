"""Build the static overlay files in public/atlas/data/ from reference data + the impact engine.

Run from the repo root:  python scripts/atlas/build_static_layers.py
Inputs:  scripts/atlas/reference/utah_counties_raw.geojson, scripts/atlas/reference/gsl_natural_earth.geojson
Outputs: public/atlas/data/{utah_counties,utah_boundary,gsl_reference,projects,
                       gsl_playa_scenarios}.geojson, by_basin.json, manifest.json
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from shapely.geometry import shape                                   # noqa: E402
from shapely.ops import unary_union                                  # noqa: E402
from backend.atlas.engine import (REGISTRY, REGISTRY_BY_ID, Levers,  # noqa: E402
                                                rounded, run_scenario)
from backend.atlas import overlays as ov                      # noqa: E402

REF, OUT = ROOT / "scripts" / "atlas" / "reference", ROOT / "public" / "atlas" / "data"
ALL = [p.id for p in REGISTRY]
CONDITIONS = Levers(cooling_required="closed_loop", power_cooling_required="dry")

SCENARIOS = {
    "stratos_built": dict(project_ids=["stratos"], branch="built"),
    "stratos_1_5gw": dict(project_ids=["stratos"], branch="built", sizes={"stratos": 1500}),
    "all_built": dict(project_ids=ALL, branch="built"),
    "all_conditions": dict(project_ids=ALL, branch="conditions", levers=CONDITIONS),
}


def write(name: str, obj) -> None:
    (OUT / name).write_text(json.dumps(obj, separators=(",", ":")))
    print(f"  {name:32s} {(OUT / name).stat().st_size / 1024:8.1f} KB")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    counties = json.loads((REF / "utah_counties_raw.geojson").read_text())
    lake = json.loads((REF / "gsl_natural_earth.geojson").read_text())["features"][0]
    results = {k: run_scenario(**v) for k, v in SCENARIOS.items()}
    base = results["all_built"]

    print("Writing public/atlas/data:")
    write("utah_counties.geojson", ov.counties_fc(counties, base, REGISTRY_BY_ID))
    boundary = unary_union([shape(f["geometry"]) for f in counties["features"]]).buffer(0)
    write("utah_boundary.geojson", ov.fc([ov.feature(boundary, {"name": "Utah"})]))
    write("gsl_reference.geojson", ov.fc([ov.feature(shape(lake["geometry"]), {
        "name": "Great Salt Lake", "source": "Natural Earth 10m lakes",
        "note": "Generalized reference outline, not the current shoreline"})]))
    write("projects.geojson", ov.projects_fc(rounded(base), REGISTRY_BY_ID))

    bands = []
    for key, res in results.items():
        g = res["totals"]["gsl"]
        acres, drop = g["playa_acres"][1], g["level_drop_ft"][1]
        pb = ov.playa_band(lake["geometry"], acres)
        if pb:
            bands.append(ov.feature(pb["band"], {
                "scenario": key, "branch": res["branch_label"],
                "playa_acres_central": round(acres), "level_drop_ft_central": round(drop, 2),
                "playa_acres_range": [round(x) for x in g["playa_acres"]],
                "illustrative": True,
                "note": "Area-equivalent inward band on a reference outline; real exposure follows bathymetry"}))
    write("gsl_playa_scenarios.geojson", ov.fc(bands))
    write("by_basin.json", {k: rounded(v["by_basin"]) for k, v in results.items()})
    write("scenario_totals.json", {k: rounded(v["totals"]) for k, v in results.items()})

    manifest = {
        "built_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "layers": {
            "utah_counties": {"source": "US Census county boundaries via plotly/datasets (GitHub)", "kind": "reference"},
            "utah_boundary": {"source": "Dissolved from utah_counties", "kind": "reference"},
            "gsl_reference": {"source": "Natural Earth 10m lakes (GitHub)", "kind": "reference",
                              "caveat": "Generalized outline, not current shoreline"},
            "projects": {"source": "impact_engine.REGISTRY (mid-2026 news/county filings)", "kind": "computed",
                         "caveat": "Coordinates approximate, county-level"},
            "gsl_playa_scenarios": {"source": "impact_engine + overlays.playa_band", "kind": "illustrative"},
            "baseline_status": {"all_basins": "placeholder"},
        },
        "to_fetch": "Run scripts/atlas/fetch_layers.py for GBIF, TRI, FIRMS, NIFC, critical habitat, WBD basins",
    }
    write("manifest.json", manifest)
    # The API bundle (backend/atlas/data) needs the lake outline for the live playa band.
    (ROOT / "backend" / "atlas" / "data" / "gsl_reference.geojson").write_text((OUT / "gsl_reference.geojson").read_text())


if __name__ == "__main__":
    main()
