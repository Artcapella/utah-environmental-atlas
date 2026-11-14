"""Four-branch comparison for one project: built as planned / with conditions / scaled down / not built.

Columns are the four branches; rows are economics and environment. Engine cells are recomputed for
each branch; published cells are quoted from the research notes with a source-type tag. Rules
(docs/atlas/design.md): ranges always, "not quantified" shown rather than zero, no net score and no
netting of dollars against deaths, and "not built here" is not zero: relocation impacts are unknown.

Published figures were gathered from 2026 news coverage, advocacy reports, government statements
and developer claims. None is independently verified here, and Stratos is the only project with
published figures on both the economic and the environmental side.
"""
from __future__ import annotations

from backend.atlas.engine import BRANCHES, REGISTRY_BY_ID, Levers, rounded, run_scenario

DEFAULT_CONDITIONS = {"cooling_required": "closed_loop", "power_cooling_required": "dry"}
NQ = "Not quantified"


def _n(value: float) -> str:
    if value == 0:
        return "0"
    return f"{value:,.0f}" if abs(value) >= 100 else f"{value:,.3g}"


def _range_text(r: list[float], unit: str) -> str:
    return f"about {_n(r[1])} {unit} (range {_n(r[0])} to {_n(r[2])})"


def _pub(text: str, tags: list[str], source: str, url: str = "", note: str = "") -> dict:
    return {"kind": "published", "text": text, "tags": tags, "source": source, "url": url, "note": note}


def _nq(text: str = NQ, note: str = "") -> dict:
    return {"kind": "nq", "text": text, "tags": [], "note": note}


def _engine(r: list[float], unit: str, note: str = "") -> dict:
    return {"kind": "engine", "text": _range_text(r, unit), "range": r, "unit": unit, "tags": ["der"],
            "source": "Atlas impact engine (sourced factor model)", "note": note}


NRDC = "EmPower Analytics for NRDC, 2026"
NRDC_URL = "https://www.nrdc.org/press-releases/stratos-data-center-will-emit-air-pollution-linked-premature-deaths-and-health"
NRDC_NOTE = ("Modeled, advocacy-commissioned and not peer-reviewed. The developer disputes it: equipment has not been "
             "selected and permitting would model the real plant. The authors say the scenarios are not predictions. "
             "More than 80% of the damages would occur outside Utah.")
UCE = "Utah Clean Energy, 2026"
UCE_URL = "https://utahcleanenergy.org/estimated-emissions-and-water-consumption-from-the-proposed-stratos-data-center/"
RELOCATE = "If the project relocates, its impacts move elsewhere: unknown, not zero. No source quantifies this for Utah."
INCENTIVES = _pub("Property-tax incentives are generally capped at 60% of new county revenue and cannot exceed 80%.",
                  ["gov"], "Utah House data center page, 2026", "https://house.utleg.gov/2026-utah-data-center-regulations/",
                  "University of Utah research finds the tax base can fluctuate as equipment depreciates.")

# PUBLISHED[project_id][row_id][branch_id] -> cells. Missing combinations read "Not quantified".
PUBLISHED: dict[str, dict[str, dict[str, list[dict]]]] = {
    "stratos": {
        "state_revenue": {
            "built": [_nq("Not published", "The governor has said new revenue should support schools, services and "
                          "military infrastructure; no amount is published.")],
            "not_built": [_nq("No project revenue here", "What the land and water earn in their current use is not quantified.")],
        },
        "county_revenue": {
            "built": [_nq("Not published", "A development authority (MIDA) created incentives for the project; their size is unknown."), INCENTIVES],
            "conditions": [_nq(), INCENTIVES], "scaled": [_nq(), INCENTIVES],
            "not_built": [_nq("No project revenue here")],
        },
        "jobs_construction": {
            "built": [_pub("About 10,000 at the construction peak", ["dev"], "Developer claim, 2026 news coverage",
                           note="Duration, local hiring share and wages are not published.")],
            "not_built": [_nq("None here")],
        },
        "jobs_permanent": {
            "built": [_pub("About 2,000", ["dev"], "Developer claim, 2026 news coverage",
                           note="For scale: state officials projected 106 full-time jobs for Creekstone, a different project.")],
            "not_built": [_nq("None here")],
        },
        "ratepayer": {
            "built": [_pub("Developer says it generates power on site and adds no load or cost to the Utah grid", ["dev"],
                           "Developer statement, 2026 news coverage"),
                      _pub("Governor: power for Stratos must not negatively affect electricity costs (S.B. 132)", ["gov"],
                           "KUTV, 2026", note="Reported statement; the bill was not checked.")],
            "not_built": [_nq("No change from this project")],
        },
        "water": {
            "built": [_pub("987 AF/yr net depletion (1,215 diverted) at full buildout", ["dev"],
                           "Developer engineering report via Salt Lake Tribune, Oct 2026",
                           note="The developer's application claims less water use than the land's current agriculture."),
                      _pub("Up to about 100,000 AF/yr", ["ind"], "BYU ecologist estimate, project research notes",
                           note="Highest figure on record. A combined-cycle estimate is about 50,000 AF/yr.")],
        },
        "air_health": {
            "built": [_pub("5 to 45 premature deaths and $75 million to $690 million in health damages a year, at 9 GW",
                           ["adv"], NRDC, NRDC_URL, NRDC_NOTE)],
            "scaled": [_pub("1.6 to 15 premature deaths and $25 million to $230 million a year, for a 3 GW first phase",
                            ["adv"], NRDC, NRDC_URL, NRDC_NOTE + " The report did not model 1.5 GW.")],
        },
        "emissions": {
            "built": [_pub("Would raise Utah's climate emissions by 55% to 75% at full buildout", ["adv"], UCE, UCE_URL,
                           "Depends on gas technology. The governor said the project will never run solely on natural "
                           "gas, with only the first phase on gas; the power plan is unsettled.")],
        },
        "heat": {
            "built": [_pub("Local temperatures could rise 5°F by day and up to 28°F at night", ["ind"],
                           "USU physics professor via Salt Lake Tribune, May 2026",
                           "https://www.sltrib.com/news/environment/2026/05/07/utahs-data-center-could-create/",
                           "A back-of-the-envelope estimate its author says could be wrong. Not peer-reviewed.")],
        },
        "wildlife": {
            "built": [_nq("Project effect not quantified"),
                      _pub("A nearby state wetland has already lost 80% of its spring flow to groundwater pumping", ["adv"],
                           "Friends of Great Salt Lake",
                           "https://fogsl.org/newsroom/file-a-protest-against-the-box-elder-data-center-water-rights-application",
                           "An existing condition, not an effect of this project.")],
        },
    },
    "creekstone": {
        "state_revenue": {"built": [_pub("$344 million in state revenue", ["gov"], "State officials' projection, Aug 2026 (Deseret News)")],
                          "not_built": [_nq("No project revenue here")]},
        "county_revenue": {"built": [_pub("$333 million in county wages", ["gov"], "State officials' projection, Aug 2026 (Deseret News)",
                                          note="Wages, not county tax revenue. Net revenue after incentives is not published."), INCENTIVES],
                           "not_built": [_nq("No project revenue here")]},
        "jobs_permanent": {"built": [_pub("106 full-time jobs", ["gov"], "State officials' projection, Aug 2026 (Deseret News)")],
                           "not_built": [_nq("None here")]},
        "jobs_construction": {"not_built": [_nq("None here")]},
        "ratepayer": {"not_built": [_nq("No change from this project")]},
        "water": {"built": [_pub("Up to 2 AF per 100 MW, about 200 AF/yr at 10 GW", ["dev"], "Developer statement, 2026 news coverage")]},
    },
}

ROWS = [
    ("Environment", "water", "Water consumed"),
    ("Environment", "gsl", "Great Salt Lake"),
    ("Environment", "air_health", "Air and health"),
    ("Environment", "emissions", "Climate emissions"),
    ("Environment", "heat", "Local heat"),
    ("Environment", "wildlife", "Wildlife and springs"),
    ("Economics", "state_revenue", "State revenue"),
    ("Economics", "county_revenue", "County revenue after incentives"),
    ("Economics", "jobs_construction", "Construction jobs"),
    ("Economics", "jobs_permanent", "Permanent jobs"),
    ("Economics", "ratepayer", "Electricity ratepayers"),
]
SCALED_DEFAULT_MW = {"stratos": 3000}   # the published first-phase case, so the health figures line up


def compare_branches(project_id: str, levers: dict | None = None, scaled_mw: float | None = None) -> dict:
    """All four branches for one registry project. Raises KeyError for an unknown id."""
    project = REGISTRY_BY_ID[project_id]
    cond = dict(levers or {})
    default_conditions = not cond
    if default_conditions:
        cond = dict(DEFAULT_CONDITIONS)
    full_mw = project.mw or 0
    if not scaled_mw or scaled_mw <= 0 or scaled_mw >= full_mw:
        scaled_mw = SCALED_DEFAULT_MW.get(project_id, full_mw * 0.5)

    def run(branch: str, lv: dict, sizes: dict | None = None) -> dict:
        return rounded(run_scenario([project_id], levers=Levers(**lv), branch=branch, scale=1.0, sizes=sizes))

    results = {
        "built": run("built", {}),
        "conditions": run("conditions", cond),
        "scaled": run("scaled", {}, {project_id: scaled_mw}),
        "not_built": run("not_built", {}),
    }
    removed = any(l["effect"] == "removed" for l in results["conditions"]["lever_log"])
    descriptions = {
        "built": f"{_n(full_mw)} MW as announced, with the developer's stated technology.",
        "conditions": ("Example conditions: closed-loop cooling and dry-cooled on-site power. Set your own in the Legislation tab."
                       if default_conditions else "With the bills and levers set in the Legislation tab.")
                      + (" A county moratorium in this scenario removes the project." if removed else ""),
        "scaled": f"{_n(scaled_mw)} MW" + (" (the published first-phase case)." if project_id in SCALED_DEFAULT_MW else
                                           f", {round(100 * scaled_mw / full_mw)}% of the announced size." if full_mw else "."),
        "not_built": "The water and land stay in their current use, or the project moves to another county or state.",
    }
    branches = []
    for bid, label in BRANCHES.items():
        t, has = results[bid]["totals"], bid != "not_built" and bool(results[bid]["projects"]) and "error" not in results[bid]["projects"][0]
        branches.append({
            "id": bid, "label": label, "description": descriptions[bid],
            "water_af": t["water_af"] if has else None,
            "level_drop_ft": t["gsl"]["level_drop_ft"] if has else None,
            "playa_acres": t["gsl"]["playa_acres"] if has else None,
            "co2_tons": t["co2_tons"] if has else None,
            "nox_tons": t["nox_tons"] if has else None,
        })
    by_id = {b["id"]: b for b in branches}
    eo = results["built"]["projects"][0].get("water_af", {}).get("eo_2026_03_test", "") if results["built"]["projects"] else ""
    published = PUBLISHED.get(project_id, {})

    def engine_cells(row: str, bid: str) -> list[dict]:
        b = by_id[bid]
        if bid == "not_built":
            return {
                "water": [_nq("Stays in current use; amount not known",
                              "Current consumptive use of the land and water rights is the first data request to the "
                              "Division of Water Rights. " + RELOCATE)],
                "gsl": [_nq("No change from this project", RELOCATE)],
                "air_health": [_nq("No on-site emissions here", RELOCATE)],
                "emissions": [_nq("No on-site emissions here", RELOCATE)],
            }.get(row, [])
        if b["water_af"] is None:
            return [_nq("Not computed", "Removed by a county moratorium in this scenario, or size unknown.")] if row in {"water", "gsl", "air_health", "emissions"} else []
        if row == "water":
            return [_engine(b["water_af"], "AF/yr", f"Net change against current land use (E.O. 2026-03): {eo}." if eo else "")]
        if row == "gsl":
            if not project.gsl_basin:
                return [_nq("Does not drain to the lake", f"{project.basin} basin.")]
            return [_engine(b["level_drop_ft"], "ft lower, long run",
                            f"Extra exposed lakebed: {_range_text(b['playa_acres'], 'acres')}.")]
        if row == "air_health":
            return [_engine(b["nox_tons"], "short tons NOx/yr from on-site gas", "Health damages are not computed by the engine.")]
        if row == "emissions":
            return [_engine(b["co2_tons"], "short tons CO2/yr from on-site gas",
                            "Grid-powered load moves emissions off site; that is not modeled.")]
        return []

    rows = []
    for group, rid, label in ROWS:
        cells = {}
        for bid in BRANCHES:
            cells[bid] = [*engine_cells(rid, bid), *published.get(rid, {}).get(bid, [])] or [_nq()]
        rows.append({"group": group, "id": rid, "label": label, "cells": cells})

    return {
        "project": {"id": project.id, "name": project.name, "county": project.county, "basin": project.basin,
                    "mw": project.mw, "lat": project.lat, "lon": project.lon, "gsl_basin": project.gsl_basin},
        "conditions_levers": cond, "conditions_default": default_conditions, "scaled_mw": scaled_mw,
        "branches": branches, "rows": rows,
        "has_published": project_id in PUBLISHED,
        "limits": [
            "No net score: rows are not added together, and dollars are never netted against deaths.",
            "Engine ranges are estimates from published factor ranges, not measurements; the high end stacks every worst-case input.",
            "Published figures are tagged by source type and none is independently verified here; several are disputed.",
            "\"Not quantified\" means no figure was found, not that the effect is zero.",
            "Most projects other than Stratos have almost no published figures on either side.",
        ],
    }
