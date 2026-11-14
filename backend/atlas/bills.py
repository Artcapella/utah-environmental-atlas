"""Bill library for the Environmental Atlas: real measures and clearly labelled mock bills.

Each entry maps a measure onto the engine's closed lever list (backend/atlas/engine.py: Levers).
A measure with no matching lever is still listed, with what it does under `not_modeled`, so the
map never implies an effect the engine cannot compute.

Real entries are summaries of news coverage, agency presentations and county documents gathered in
Nov 2026 (docs/atlas/research_notes.md). None was checked against the enrolled bill text; `basis`
says where each summary came from. Mock entries exist to show what a kind of rule would change.
"""
from __future__ import annotations

from copy import deepcopy

from backend.atlas.engine import Levers

BILLS: list[dict] = [
    {
        "id": "hb76_2026", "label": "H.B. 76 (2026)", "title": "Data Center Water Transparency Amendments",
        "kind": "law", "real": True, "status": "Enacted; in effect July 1, 2026",
        "levers": {"reporting_threshold_af": 75},
        "summary": "Large data centers submit projected water use, discharge, treatment and reuse plans before "
                   "construction. Those using 75 acre-feet or more a year report use and conservation efforts annually "
                   "to the Division of Water Rights, which publishes the reports online. Data centers already operating "
                   "or under construction on July 1, 2026 are exempt. The first actual-use numbers are expected around "
                   "September 2027.",
        "map_effect": "Reporting changes what the state knows, not water use: the map's water and lake estimates stay "
                      "the same, and each project is marked as reporting or below the threshold.",
        "not_modeled": [],
        "source": {"name": "Division of Water Rights presentation to the Natural Resources, Agriculture and "
                           "Environment Interim Committee, Aug 19, 2026",
                   "url": "https://le.utah.gov/interim/2026/pdf/00003109.pdf"},
        "source_type": "gov", "basis": "Summary of an agency presentation, not the bill text.",
    },
    {
        "id": "hb60_2026", "label": "H.B. 60 (2026)", "title": "Limits on factors in water-right decisions",
        "kind": "law", "real": True, "status": "Enacted; in effect May 6, 2026",
        "levers": {},
        "summary": "Limits the factors the State Engineer can weigh when deciding water-right applications. Only the "
                   "Legislature can change those limits.",
        "map_effect": "No change on the map: the law affects what can be argued in a water-right proceeding, not how "
                      "much water a project would use.",
        "not_modeled": ["Narrows the factors the State Engineer may weigh on a water-right application."],
        "source": {"name": "Utah News Dispatch, May 18, 2026",
                   "url": "https://utahnewsdispatch.com/2026/05/18/data-center-new-utah-law-gives-less-weight-to-pushback-citing-broad-impact/"},
        "source_type": "gov", "basis": "News coverage of the law; the bill text is the primary source and was not checked.",
    },
    {
        "id": "eo_2026_03", "label": "E.O. 2026-03", "title": "Executive order: water consumption principle",
        "kind": "executive_order", "real": True, "status": "Governor's executive order",
        "levers": {},
        "summary": "The governor's office describes one principle of the order as ensuring water consumption is not "
                   "increased. The atlas turns that into a test: a project's estimated use against the current "
                   "consumptive use of the land and water rights it would convert.",
        "map_effect": "No change on the map. The test appears in the Water row for each project and reads \"cannot "
                      "test\" until the Division of Water Rights supplies current consumptive use.",
        "not_modeled": ["The net-change test is the atlas's own reading of the principle; how agencies apply the order "
                        "is up to them."],
        "source": {"name": "Governor's office description, via 2026 news coverage", "url": ""},
        "source_type": "gov", "basis": "Description of one principle; the order's text was not checked.",
    },
    {
        "id": "sb132", "label": "S.B. 132", "title": "Electricity cost protection cited for large loads",
        "kind": "law", "real": True, "status": "Cited by the governor; not verified here",
        "levers": {},
        "summary": "The governor said power for Stratos must not negatively affect electricity costs under S.B. 132.",
        "map_effect": "No change on the map: ratepayer effects are not modeled.",
        "not_modeled": ["Ratepayer protection for large electric loads."],
        "source": {"name": "KUTV coverage of the governor's statement, 2026", "url": ""},
        "source_type": "gov", "basis": "A statement reported in the news; the bill and its year were not checked.",
    },
    {
        "id": "iron_2026_13", "label": "Iron Co. Ord. 2026-13", "title": "Iron County data center and solar moratorium",
        "kind": "county_ordinance", "real": True, "status": "County ordinance; moratoria are capped at 180 days",
        "levers": {"moratorium_counties": ["Iron"]},
        "summary": "A temporary county moratorium on new data center and solar approvals in Iron County.",
        "map_effect": "Iron County is outlined and its projects (Antelope, Red Butte) are removed from the scenario.",
        "not_modeled": ["The lever removes every Iron County project in the registry. The ordinance may not reach "
                        "projects permitted earlier: Antelope received a county permit in June 2026. Not verified.",
                        "A moratorium lasts at most 180 days; the engine treats it as permanent."],
        "source": {"name": "Iron County Ordinance 2026-13",
                   "url": "https://ironcountyut.gov/files/planning/data-center-solar-moratorium.pdf"},
        "source_type": "gov", "basis": "County document link from the research notes; the ordinance was not read in full.",
    },
    {
        "id": "cache_2026_32", "label": "Cache Co. Ord. 2026-32", "title": "Cache County data center moratorium",
        "kind": "county_ordinance", "real": True, "status": "County ordinance; moratoria are capped at 180 days",
        "levers": {"moratorium_counties": ["Cache"]},
        "summary": "A temporary county moratorium on data center approvals in Cache County.",
        "map_effect": "Cache County is outlined. No project in the registry is in Cache County, so the estimates do "
                      "not change.",
        "not_modeled": ["A moratorium lasts at most 180 days; the engine treats it as permanent."],
        "source": {"name": "Cache County Ordinance 2026-32",
                   "url": "https://www.cachecounty.gov/assets/department/countycouncil/pr/dcmo.pdf"},
        "source_type": "gov", "basis": "County document link from the research notes; the ordinance was not read in full.",
    },
    {
        "id": "mock_dry_cooling", "label": "Mock H.B. 9999", "title": "Data Center Cooling Standards (mock)",
        "kind": "mock", "real": False, "status": "Illustration only. Not real legislation",
        "levers": {"cooling_required": "closed_loop", "power_cooling_required": "dry"},
        "summary": "Would require closed-loop cooling for data halls and dry or air-cooled condensers for on-site gas "
                   "power, with no wet cooling towers.",
        "map_effect": "Project circles and the exposed-lakebed band shrink. Air emissions do not change: that is the "
                      "trade-off.",
        "not_modeled": ["An annual public summary of data center electricity generation."],
        "source": {"name": "docs/atlas/samples/bills/MOCK_dry_cooling_bill.txt", "url": ""},
        "source_type": "der", "basis": "Written for this atlas to demonstrate the levers.",
    },
    {
        "id": "mock_gsl_offset", "label": "Mock: lake offset", "title": "Great Salt Lake offset requirement (mock)",
        "kind": "mock", "real": False, "status": "Illustration only. Not real legislation",
        "levers": {"gsl_offset_ratio": 1.0},
        "summary": "Would require a data center in a basin that drains to the Great Salt Lake to deliver one acre-foot "
                   "to the lake for each acre-foot it consumes.",
        "map_effect": "The exposed-lakebed band disappears; project water use is unchanged.",
        "not_modeled": ["Where the offset water would come from, and what its current use is."],
        "source": {"name": "Written for this atlas", "url": ""},
        "source_type": "der", "basis": "Written for this atlas to demonstrate the levers.",
    },
    {
        "id": "mock_grid_only", "label": "Mock: no on-site gas", "title": "Grid-only power for data centers (mock)",
        "kind": "mock", "real": False, "status": "Illustration only. Not real legislation",
        "levers": {"onsite_gas_allowed": False},
        "summary": "Would prohibit on-site natural gas generation at large data centers.",
        "map_effect": "Project circles shrink because on-site power plants no longer use cooling water.",
        "not_modeled": ["The power would come from the grid instead. Water use and emissions at grid power plants, "
                        "and effects on electricity rates, are not modeled, so this is not a statewide reduction."],
        "source": {"name": "Written for this atlas", "url": ""},
        "source_type": "der", "basis": "Written for this atlas to demonstrate the levers.",
    },
]
BILLS_BY_ID = {b["id"]: b for b in BILLS}

for _bill in BILLS:   # fail at import, not in front of a legislator, if a lever name drifts from the engine
    Levers(**_bill["levers"])


def list_bills() -> list[dict]:
    return deepcopy(BILLS)


def merge_levers(bill_ids: list[str], extra: dict | None = None) -> dict:
    """Levers from several bills plus manual ones. Moratorium counties accumulate; other levers: last wins."""
    out: dict = {}
    for source in [*(BILLS_BY_ID[i]["levers"] for i in bill_ids if i in BILLS_BY_ID), extra or {}]:
        for key, value in source.items():
            if key == "moratorium_counties":
                out[key] = list(dict.fromkeys([*out.get(key, []), *value]))
            else:
                out[key] = value
    return out
