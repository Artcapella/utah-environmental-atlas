"""Knowledge index for the atlas assistant: every data source the atlas uses, as searchable documents.

Documents come from the source catalog, the project registry and its published figures, the permit
pipeline, basin assignments, the bill library, engine factors, the branch comparison, the decision
context, the research notes and a guide to the app itself. `scripts/atlas/build_knowledge.py`
writes them to backend/atlas/data/knowledge.json (shipped with the Python function, since public/
and docs/ may not be) and embeds them into knowledge_vectors.json.

Search is hybrid: BM25 keywords fused with embedding similarity (reciprocal rank fusion). Without
vectors, or when the embedding service is down, it is keyword-only.

Basin baselines are invented placeholders, so their numbers are deliberately left out: the
assistant can explain the basin model but cannot quote a placeholder as a finding.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path

from backend.atlas import llm
from backend.atlas.bills import BILLS
from backend.atlas.comparison import PUBLISHED, ROWS
from backend.atlas.engine import BRANCHES, FACTORS, REGISTRY, SOURCE_TYPES, rounded, run_scenario

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(__file__).resolve().parent / "data"
KNOWLEDGE_FILE = DATA / "knowledge.json"
VECTORS_FILE = DATA / "knowledge_vectors.json"
PUBLIC = ROOT / "public" / "atlas" / "data"
MAX_CHUNK = 900


@dataclass
class Doc:
    id: str
    kind: str            # source | project | figure | permit | basin | bill | factor | comparison | context | research | app
    title: str
    text: str
    source_name: str
    url: str = ""
    source_type: str | None = None      # gov | dev | ind | adv | der
    verified: bool | None = None        # False = link or figure not yet checked by a person
    placeholder: bool = False
    lat: float | None = None
    lon: float | None = None
    tags: list[str] = field(default_factory=list)

    @property
    def digest(self) -> str:
        return hashlib.sha1(f"{self.title}\n{self.text}".encode()).hexdigest()[:16]

    def embed_text(self) -> str:
        return f"{self.title}\n{self.text}"[:6000]


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60]


def _n(value) -> str:
    if value is None:
        return "not published"
    return f"{value:,.0f}" if abs(value) >= 100 else f"{value:,.3g}"


def _chunks(text: str) -> list[str]:
    out, current = [], ""
    for para in [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]:
        if current and len(current) + len(para) > MAX_CHUNK:
            out.append(current)
            current = ""
        current = f"{current}\n{para}".strip()
    return out + ([current] if current else [])


def _markdown_sections(path: Path) -> list[tuple[str, str]]:
    if not path.exists():
        return []
    sections, title, lines = [], None, []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            if title:
                sections.append((title, "\n".join(lines)))
            title, lines = re.sub(r"^\d+\.\s*", "", line[3:].strip()), []
        elif title:
            lines.append(line)
    if title:
        sections.append((title, "\n".join(lines)))
    return sections


def _json(path: Path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


APP_GUIDE = [
    ("What this atlas is", "The Utah Environmental Atlas shows on a map how proposed data centers, and the bills that "
     "would regulate them, would affect Utah's water and the Great Salt Lake. It is decision support for the Legislature, "
     "not advocacy: it gives ranges from a sourced factor model, shows developer, engine and highest-on-record figures "
     "side by side, tags every published figure by source type, and makes no recommendations. Ask for a tour to be "
     "shown around (action start_tour)."),
    ("Map: proposed data centers", "Layer 'Proposed data centers' (layer id atlas-projects). Each circle is a proposed "
     "data center; its area is the engine's central water estimate in acre-feet per year. Blue circles drain to the "
     "Great Salt Lake, brown ones to other basins. Click a circle for its estimate, the developer's stated use, water "
     "rights and the highest figure on record. Locations are approximate. To show one: select_projects and fly_to with its project_id."),
    ("Impact tab: Projects", "Impact tab, Projects sub-tab (impact_tab proposed). Tick the proposed data centers to "
     "include, choose a size for projects with phases, and the map and the result rows recompute. Results: Water, Great "
     "Salt Lake and dust, Air and climate (computed ranges), and Biodiversity, Wildfire, Pollution (overlap flags)."),
    ("Impact tab: Legislation and the bill library", "Impact tab, Legislation sub-tab (impact_tab legislation). The bill "
     "library lists real measures (H.B. 76, H.B. 60, E.O. 2026-03, S.B. 132, Iron and Cache county moratoria) and mock "
     "bills. Applying a bill sets its levers and redraws the map (action apply_bill with a bill_id). You can also set "
     "levers by hand or paste bill text for Gemini to read into levers, each with its quote, confirmed before it applies."),
    ("Map: with and without a bill", "When a bill or lever is applied, the map draws both cases at once: a dashed grey "
     "ring for each project built as planned (without the bill) and a solid ring for the scenario (with it), a dashed "
     "outline for the lakebed exposed without the bill and a filled band with it, and outlines for counties under a "
     "moratorium. A legend on the map gives the change in water use and lake level."),
    ("Map: four branches strip", "The four-branch strip docks over the map for one project (action open_compare with a "
     "project_id). Its cards are Built as planned, Built with conditions, Delayed or scaled down, and Not built here. "
     "Choosing a card redraws the map for that branch. Rows below compare economics and environment with source tags; "
     "cells with no figure read 'Not quantified'. There is no net score. Not built here is not zero: relocation impacts are unknown."),
    ("Impact tab: Basins", "Impact tab, Basins sub-tab (impact_tab basins) and layer 'Basin water risk' (layer id "
     "atlas-basinrisk). It scores each basin from counted demand against supply headroom, junior-right share, storage "
     "and growth trend, with a dry-year slider. The basin baselines are invented placeholders until the Division of "
     "Water Rights or Water Resources supplies data, so the scores show how levers shift relative risk and are not findings."),
    ("Impact tab: Permits", "Impact tab, Permits sub-tab (impact_tab pipeline) and layer 'Data center permit pipeline' "
     "(layer id atlas-permits). Each project shows five gates: land use, water right, air permit, water quality and "
     "construction, with who decides, sources, dated events and open decisions. 'Not found' means no filing was found, "
     "not that none exists."),
    ("Impact tab: Drop a project", "Impact tab, Drop a project sub-tab (impact_tab drop). Set a size in MW, cooling type, "
     "on-site gas and whether it drains to the Great Salt Lake, then click the map to place a hypothetical data center. "
     "The county is detected from the click and the engine adds it to the scenario."),
    ("Impact tab: Who decides", "Impact tab, Who decides sub-tab (impact_tab context). Lists the audiences, the interim "
     "committees studying data centers, the legal context and the source-type tags."),
    ("Map layers for water", "Layers tab, group 'Data centers & water'. Layer ids: atlas-projects (proposed data "
     "centers), atlas-permits (permit pipeline), atlas-lake (Great Salt Lake outline and extra exposed lakebed), "
     "atlas-basinrisk (basin water risk, placeholder baselines), atlas-water (computed water use by county), "
     "atlas-reference (county lines), atlas-wbd-tiles (USGS watershed boundaries), atlas-fema-tiles (FEMA flood zones). "
     "Use set_layer to turn one on or off."),
    ("Great Salt Lake on the map", "Layer 'Great Salt Lake and extra exposed lakebed' (layer id atlas-lake). The tan band "
     "inside the lake outline has the area of lakebed the scenario would expose in the long run, counting only projects "
     "in basins that drain to the lake. The band has the estimated area but not the real shape, which follows the lake "
     "floor. To show it: fly_to place great_salt_lake."),
    ("Legislative briefing", "The briefing (action open_briefing, or /briefing) is a one-page print view: statewide "
     "totals, what each lever would change alone, then by basin and by project, with a fixed data-limits box. It is "
     "watermarked as a draft while basin baselines are placeholders."),
    ("Water screen for one proposal", "The water screen (/screen, or 'Screen' beside a project in the Impact tab and in a "
     "project's map popup) reviews a single data center proposal for a city council, county commission, water provider "
     "or state reviewer. It gives a first estimate of cooling water and power-plant water, checks the developer's stated "
     "water use against that estimate (too low, cooling only, partial or consistent), ranks ways to use less water, and "
     "lists red flags, questions to ask the developer, a scope for the in-depth hydrology study, possible conditions of "
     "approval and a screening memo to copy into a staff report. It opens with the facts the Atlas registry records for "
     "the project; what a developer has not disclosed stays unknown. The screen is a separate, simpler model than the "
     "impact engine: it uses national-average coefficients and counts water consumed by grid power plants, which the "
     "engine does not. Its claim check shows the developer's figure, the screen's estimate, the engine's estimate and "
     "the highest figure on record side by side, and never merges them. It is a screening estimate, not a hydrologic finding."),
    ("Show the math and citations", "At the bottom of the Impact tab: 'Show the math' lists the formulas, factor ranges "
     "with sources and per-project assumptions. 'Copy citation' and 'Download citation' export the scenario's inputs, "
     "factors and sources as text for a filing or a memo."),
    ("How to read the ranges", "Every engine output is a low, central and high value. Low uses every favourable input "
     "and high stacks every worst-case input, so the high end is an upper bound, not a forecast. Where a project has "
     "not said how it will be cooled or powered, the range spans the possibilities. Estimates are not measurements."),
    ("Air quality and inversion tools", "The Today tab and the Conditions layers show live Utah DAQ air monitors, "
     "National Weather Service forecasts and the winter inversion estimate. The assistant can also answer from these "
     "live readings for wherever the map is centred."),
]


def build_documents() -> list[Doc]:
    docs: list[Doc] = []

    # ---- source catalog
    for s in _json(ROOT / "scripts" / "atlas" / "sources.json") or []:
        url = s.get("url", "")
        parts = [f"{s['name']}.", f"Category: {s.get('category', 'other')}.", f"Access: {s.get('kind', 'page')}."]
        if s.get("notes"):
            parts.append(f"Notes: {s['notes']}.")
        parts.append(f"Used by the atlas for: {s['used_by']}." if s.get("used_by") else "Not yet wired into the atlas.")
        parts.append("Link checked by a person: yes." if s.get("verified") else "Link not yet checked by a person.")
        docs.append(Doc(f"source:{_slug(s['name'])}", "source", s["name"], " ".join(parts), "Atlas source catalog",
                        url if url.startswith("http") and "{" not in url else "", verified=bool(s.get("verified")),
                        tags=[s.get("category", "")]))

    # ---- project registry, engine estimate and published figures
    for p in REGISTRY:
        res = rounded(run_scenario([p.id]))
        row = res["projects"][0]
        text = [f"{p.name}, {p.county} County, basin: {p.basin}. Announced size {_n(p.mw)} MW. Status: {p.status}."]
        text.append(f"Cooling: {row['assumptions']['cooling']}. On-site gas: {row['assumptions']['onsite_gas']}. "
                    f"Drains to the Great Salt Lake: {'yes' if p.gsl_basin else 'no'}.")
        w = row["water_af"]
        text.append(f"Engine estimate, built as planned: about {_n(w['total'][1])} AF/yr (range {_n(w['total'][0])} to "
                    f"{_n(w['total'][2])}), of which data-hall cooling {_n(w['site'][1])} and on-site power plant {_n(w['power'][1])}. "
                    "This is a factor-model estimate, not a measurement.")
        text.append(f"Developer-stated use: {_n(p.stated_af)} AF/yr. Water rights held or sought: {_n(p.rights_af)} AF. "
                    f"Highest figure on record: {_n(p.published_high_af)} AF/yr.")
        if p.gsl_basin:
            g = res["totals"]["gsl"]
            text.append(f"Great Salt Lake, long run: about {_n(g['level_drop_ft'][1])} ft lower (range {_n(g['level_drop_ft'][0])} to "
                        f"{_n(g['level_drop_ft'][2])}), about {_n(g['playa_acres'][1])} acres more exposed lakebed.")
        if p.size_options_mw:
            text.append("Size options: " + "; ".join(f"{k} = {_n(v)} MW" for k, v in p.size_options_mw.items()) + ".")
        text.append(f"Net change against current land use (E.O. 2026-03): {w['eo_2026_03_test']}.")
        if p.notes:
            text.append(p.notes)
        text.append("Location is approximate (county level).")
        docs.append(Doc(f"project:{p.id}", "project", f"{p.name}: project record and engine estimate", " ".join(text),
                        "Atlas project registry and impact engine (2026 news and county filings)", source_type="der",
                        lat=p.lat, lon=p.lon, tags=[p.id, p.county, p.basin]))
        for fig in p.figures:
            kinds = ", ".join(SOURCE_TYPES.get(t, t) for t in fig.source_types)
            docs.append(Doc(f"figure:{p.id}:{_slug(fig.label)}", "figure", f"{p.name} water figure: {fig.label}",
                            f"{_n(fig.value_af)} AF/yr. {fig.label}. Source type: {kinds}. Source: {fig.source}. "
                            "Shown beside the engine range, never merged into it.",
                            fig.source, fig.url, source_type=fig.source_types[0], verified=False,
                            lat=p.lat, lon=p.lon, tags=[p.id]))

    # ---- permit pipeline
    permits = _json(PUBLIC / "permits.geojson")
    if permits:
        labels, gate_names = permits["status_labels"], {"land": "Land use", "water": "Water right", "air": "Air permit",
                                                         "wq": "Water quality", "build": "Construction"}
        for f in permits["features"]:
            p = f["properties"]
            lon, lat = f["geometry"]["coordinates"][:2]
            gates = " ".join(f"{gate_names[g]}: {labels.get(p['gates'][g], p['gates'][g])}. {p['notes'].get(g, '')}" for g in gate_names)
            src = "; ".join(s.get("label", "") for s in p.get("sources", []))
            first_url = next((s["url"] for s in p.get("sources", []) if str(s.get("url", "")).startswith("http")), "")
            docs.append(Doc(f"permit:{_slug(p['name'])}", "permit", f"{p['name']}: permit pipeline",
                            f"{p['name']}, {p['county']} County. Stage: {p['tier_label']}. Who decides: {p['who_decides']}. "
                            f"{gates} Not found: {p.get('gaps', '')} Sources: {src or 'none found'}. Latest source {p.get('as_of') or 'n/a'}. "
                            f"{'In the impact engine.' if p.get('in_registry') else 'Not in the impact engine; ' + str(p.get('location', ''))}",
                            "Permit pipeline: news, county and agency records", first_url, verified=False,
                            lat=lat, lon=lon, tags=[p.get("engine_id") or "", p["county"]]))
        events = permits.get("events", [])
        upcoming = [f"{day}: {txt}" for day, txt in events if day >= permits["as_of"] and txt != "Today"]
        past = [f"{day}: {txt}" for day, txt in events if day < permits["as_of"]]
        if upcoming:
            docs.append(Doc("permit:events-upcoming", "permit", "Permit pipeline: upcoming dated events",
                            f"As of {permits['as_of']}. " + " ".join(upcoming), "Permit pipeline: news, county and agency records"))
        for i, chunk in enumerate(_chunks("\n\n".join(past))):
            docs.append(Doc(f"permit:events-past-{i + 1}", "permit", "Permit pipeline: past dated events", chunk,
                            "Permit pipeline: news, county and agency records"))
        if permits.get("open_decisions"):
            docs.append(Doc("permit:open-decisions", "permit", "Permit pipeline: open decisions",
                            " ".join(f"{what} ({when})." for what, when in permits["open_decisions"]),
                            "Permit pipeline: news, county and agency records"))

    # ---- basins (no placeholder numbers) and Great Salt Lake context
    basin = _json(PUBLIC / "basin_risk.json")
    if basin:
        for b in basin["basins"]:
            members = [p for p in basin["projects"] if p["basin"] == b["name"]]
            names = "; ".join(f"{p['name']} ({p['status']}{', basin assignment uncertain' if p.get('basin_uncertain') else ''})" for p in members)
            docs.append(Doc(f"basin:{_slug(b['name'])}", "basin", f"{b['name']} basin: water risk view",
                            f"{b['name']} basin. Data centers assigned to it: {names or 'none'}. The basin risk score mixes counted "
                            "demand against supply headroom, junior-right share, storage buffer and growth trend. The baselines "
                            "for supply, junior-right share, storage and trend are invented placeholders until the Division of "
                            "Water Rights or Water Resources supplies data, so no baseline number or score is a finding.",
                            "Atlas basin water-risk model (placeholder baselines)", placeholder=True,
                            lat=b["lat"], lon=b["lon"], tags=[b["name"]]))
        for p in basin["projects"]:
            if p.get("note"):
                docs.append(Doc(f"basinproject:{_slug(p['name'])}", "project", f"{p['name']}: water figures and notes",
                                f"{p['name']}, {p['basin']} basin{' (assignment uncertain)' if p.get('basin_uncertain') else ''}. "
                                f"Status: {p['status']}; expected online {p['year']} ({p.get('year_basis', 'assumed')}). "
                                f"Developer-stated use: {_n(p.get('stated_af'))} AF/yr. Water rights: {_n(p.get('rights_af'))} AF. "
                                f"Highest independent estimate: {_n(p.get('independent_high_af'))} AF/yr. {p['note']}",
                                "Project research notes (2026 news and filings)", verified=False, tags=[p.get("engine_id") or ""]))
        docs.append(Doc("context:gsl-need", "context", "Great Salt Lake: additional inflow needed",
                        f"The Great Salt Lake needs about {_n(basin['gsl_need_af'])} AF/yr more inflow ({basin['gsl_need_source']}).",
                        basin["gsl_need_source"], source_type="gov", verified=False, lat=41.1, lon=-112.5))
        docs.append(Doc("context:utah-capacity", "context", "Utah generating capacity, for scale",
                        f"Utah's total electric generating capacity is about {_n(basin['utah_capacity_mw'])} MW "
                        f"({basin['utah_capacity_source']}). Announced data center sizes are compared against it.",
                        basin["utah_capacity_source"], source_type="gov", verified=False))
        docs.append(Doc("basin:lenses", "basin", "Basin view: ways to count data center demand",
                        " ".join(f"{v.get('label', k)}: {v.get('desc', '')}" for k, v in basin["lenses"].items())
                        + " Engine estimate: uses the impact engine's central estimate for the current scenario, so a bill's levers move the basin scores.",
                        "Atlas basin water-risk model (placeholder baselines)", placeholder=True))

    # ---- bills
    for b in BILLS:
        levers = "; ".join(f"{k} = {v}" for k, v in b["levers"].items()) or "none (not modeled by the engine)"
        docs.append(Doc(f"bill:{b['id']}", "bill", f"{b['label']}: {b['title']}",
                        f"{b['label']}, {b['title']}. {'Real measure' if b['real'] else 'MOCK bill for illustration, not real legislation'}. "
                        f"Status: {b['status']}. {b['summary']} Engine levers: {levers}. On the map: {b['map_effect']} "
                        f"Not modeled: {' '.join(b['not_modeled']) or 'nothing further'} Basis: {b['basis']} (bill_id {b['id']})",
                        b["source"]["name"], b["source"]["url"], source_type=b["source_type"], verified=False, tags=[b["id"]]))

    # ---- engine factors and formulas
    for key, (lo, c, hi, source) in FACTORS.items():
        docs.append(Doc(f"factor:{key}", "factor", f"Engine factor: {key}",
                        f"Factor {key}: low {lo}, central {c}, high {hi}. Source: {source}.", source, source_type="der"))
    docs.append(Doc("factor:formulas", "factor", "Impact engine formulas",
                    "Site water, AF = (MW / PUE) x 8,760 h x load factor x 1,000 x WUE / 1,233,482 L per AF. "
                    "Gas plant water, AF = MW x 8,760 x load factor x gal per MWh / 325,851 gal per AF. "
                    "Great Salt Lake level, ft = net depletion / 100,000 x ft per 100,000 AF; exposed lakebed = ft x acres per ft; "
                    "only projects in basins that drain to the lake count. Unknown cooling: central closed-loop, high evaporative. "
                    "Unknown on-site gas: low grid, central and high gas. Unknown power cooling: low dry, central and high wet. "
                    "The low end uses all-low inputs and the high end all-high inputs.",
                    "Atlas impact engine (backend/atlas/engine.py)", source_type="der"))

    # ---- branch comparison (published cells)
    row_labels = {rid: label for _, rid, label in ROWS}
    by_id = {p.id: p for p in REGISTRY}
    for pid, rows in PUBLISHED.items():
        for rid, branches in rows.items():
            cells = [(bid, c) for bid, cs in branches.items() for c in cs]
            text = " ".join(f"{BRANCHES[bid]}: {c['text']}"
                            + (f" [{', '.join(SOURCE_TYPES.get(t, t) for t in c['tags'])}; {c.get('source', '')}]" if c["tags"] else "")
                            + (f" {c['note']}" if c.get("note") else "") + "." for bid, c in cells)
            first = next((c for _, c in cells if c["kind"] == "published"), None)
            docs.append(Doc(f"comparison:{pid}:{rid}", "comparison", f"{by_id[pid].name}: {row_labels[rid]} by branch",
                            text + " Branches with no entry are not quantified. Rows are never added into a net score.",
                            first["source"] if first else "Atlas four-branch comparison", first.get("url", "") if first else "",
                            source_type=first["tags"][0] if first else None, verified=False,
                            lat=by_id[pid].lat, lon=by_id[pid].lon, tags=[pid]))

    # ---- decision context
    ctx = _json(PUBLIC / "context.json")
    if ctx:
        docs.append(Doc("context:audiences", "context", "Who the atlas is for",
                        " ".join(f"{a['who']}{' (primary audience)' if a.get('primary') else ''}: decides {a['decides']}; view: {a['view']}; output: {a['output']}."
                                 for a in ctx["audiences"]), "Atlas decision context"))
        docs.append(Doc("context:committees", "context", "Legislative committees studying data centers",
                        " ".join(f"{c['name']}: {c['role']}{' (unconfirmed)' if c.get('unconfirmed') else ''}" for c in ctx["committees"])
                        + " Bills would come in the 2027 General Session.", "Atlas decision context", source_type="gov", verified=False))
        docs.append(Doc("context:legal", "context", "Legal context for data center water decisions",
                        " ".join(ctx["legal_context"]), "Atlas decision context", source_type="gov", verified=False))
        docs.append(Doc("context:rules", "context", "Display rules the atlas follows",
                        " ".join(ctx["rules"]) + " Source types: " + ", ".join(ctx["source_types"].values()) + ".",
                        "Atlas decision context"))
    manifest = _json(PUBLIC / "manifest.json")
    if manifest:
        layers = "; ".join(f"{k}: {v.get('source', '')}{' (' + v['caveat'] + ')' if v.get('caveat') else ''}"
                           for k, v in manifest["layers"].items() if isinstance(v, dict) and "source" in v)
        docs.append(Doc("context:data-status", "context", "Data status: what is built, placeholder or not yet loaded",
                        f"Static map layers built {manifest.get('built_at', '')[:10]}: {layers}. Basin baselines: "
                        f"{manifest['layers'].get('baseline_status', {}).get('all_basins', 'placeholder')}. "
                        "Not yet loaded (optional fetch): GBIF species hexes, EPA TRI facilities, NASA FIRMS fire detections, "
                        "NIFC fire perimeters, USFWS critical habitat and USGS HUC8 basins, so the Biodiversity, Wildfire and "
                        "Pollution overlap flags read 'layer not loaded'. No link in the source catalog has been checked by a person yet.",
                        "Atlas data manifest", placeholder=True))

    # ---- research notes and design rules
    for title, body in _markdown_sections(ROOT / "docs" / "atlas" / "research_notes.md"):
        for i, chunk in enumerate(_chunks(body)):
            docs.append(Doc(f"research:{_slug(title)}-{i + 1}", "research", f"Research notes: {title}", chunk,
                            "Project research notes (summaries, not independently re-verified)", verified=False))
    for title, body in _markdown_sections(ROOT / "docs" / "atlas" / "design.md"):
        if title in {"Audiences and goals", "Guardrails", "Decisions"}:
            for i, chunk in enumerate(_chunks(body)):
                docs.append(Doc(f"design:{_slug(title)}-{i + 1}", "context", f"Atlas design: {title}", chunk, "Atlas design document"))

    # ---- the app itself
    for title, text in APP_GUIDE:
        docs.append(Doc(f"app:{_slug(title)}", "app", title, text, "Atlas user guide"))

    seen: dict[str, Doc] = {}
    for d in docs:   # ids must be unique; a duplicate name keeps the first
        seen.setdefault(d.id, d)
    return list(seen.values())


# ---------------------------------------------------------------- index
_STOP = set("a an and are as at be by for from has have how in is it its of on or that the this to was what when where "
            "which who will with would do does can about into than then there their them they you your our we i me my much many "
            "any some show tell give please explain say says said mean there here".split())
_ALIASES = [(r"\bh\.?\s?b\.?\s*(\d+)", r"hb\1"), (r"\bs\.?\s?b\.?\s*(\d+)", r"sb\1"), (r"\be\.?\s?o\.?\s*(\d{4})-?(\d+)", r"eo\1\2"),
            (r"\bgsl\b", "great salt lake"), (r"\bacre[- ]f(?:ee|oo)t\b", "af"), (r"\bdatacent(?:er|re)s?\b", "data center")]


def tokens(text: str) -> list[str]:
    text = text.lower()
    for pattern, repl in _ALIASES:
        text = re.sub(pattern, repl, text)
    out = []
    for word in re.findall(r"[a-z0-9]+", text):
        if word in _STOP or (len(word) < 2 and not word.isdigit()):
            continue
        if len(word) > 4 and word.endswith("ies"):
            word = word[:-3] + "y"
        elif len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]
        out.append(word)
    return out


@dataclass
class Hit:
    doc: Doc
    score: float


class Index:
    def __init__(self, docs: list[Doc], vectors: dict[str, list[float]] | None = None, tag: str | None = None):
        self.docs = docs
        self.by_id = {d.id: d for d in docs}
        self.tag = tag if vectors else None
        self.vectors = vectors or {}
        self._tf: list[dict[str, float]] = []
        df: dict[str, int] = {}
        for d in docs:
            tf: dict[str, float] = {}
            for t in tokens(d.title) * 4 + tokens(d.text) + tokens(" ".join(d.tags)):
                tf[t] = tf.get(t, 0) + 1
            self._tf.append(tf)
            for t in tf:
                df[t] = df.get(t, 0) + 1
        n = max(len(docs), 1)
        self._idf = {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}
        self._len = [sum(tf.values()) for tf in self._tf]
        self._avg = (sum(self._len) / n) or 1.0

    def keyword(self, query: str) -> list[tuple[int, float]]:
        q = list(dict.fromkeys(tokens(query)))
        scored = []
        for i, tf in enumerate(self._tf):
            s = 0.0
            for t in q:
                f = tf.get(t)
                if f:
                    s += self._idf[t] * f * 2.2 / (f + 1.2 * (0.55 + 0.45 * self._len[i] / self._avg))
            if s > 0:
                scored.append((i, s))
        return sorted(scored, key=lambda x: -x[1])

    def semantic(self, qvec: list[float]) -> list[tuple[int, float]]:
        qn = math.sqrt(sum(x * x for x in qvec)) or 1.0
        scored = []
        for i, d in enumerate(self.docs):
            v = self.vectors.get(d.id)
            if v and len(v) == len(qvec):
                vn = math.sqrt(sum(x * x for x in v)) or 1.0
                scored.append((i, sum(a * b for a, b in zip(qvec, v)) / (qn * vn)))
        return sorted(scored, key=lambda x: -x[1])

    def search(self, query: str, k: int = 6, kinds: set[str] | None = None, qvec: list[float] | None = None) -> list[Hit]:
        fused: dict[int, float] = {}
        rankings = [self.keyword(query)]
        if qvec and self.vectors:
            rankings.append(self.semantic(qvec)[:40])
        for ranking in rankings:
            for rank, (i, _) in enumerate(ranking):
                fused[i] = fused.get(i, 0.0) + 1.0 / (60 + rank)
        hits = [Hit(self.docs[i], s) for i, s in sorted(fused.items(), key=lambda x: -x[1])
                if not kinds or self.docs[i].kind in kinds]
        return hits[:k]


@lru_cache(maxsize=1)
def get_index() -> Index:
    """The shipped index; rebuilt from the repo files when the shipped file is absent (local dev)."""
    if KNOWLEDGE_FILE.exists():
        docs = [Doc(**d) for d in json.loads(KNOWLEDGE_FILE.read_text(encoding="utf-8"))["docs"]]
    else:
        docs = build_documents()
    vectors, tag = {}, None
    if VECTORS_FILE.exists():
        stored = json.loads(VECTORS_FILE.read_text(encoding="utf-8"))
        digests = {d.id: d.digest for d in docs}
        tag = stored.get("tag")
        vectors = {i: item["v"] for i, item in stored.get("items", {}).items() if digests.get(i) == item.get("h")}
    return Index(docs, vectors, tag)


_query_cache: dict[tuple[str, str], list[float]] = {}


async def search(query: str, k: int = 6, kinds: set[str] | None = None) -> tuple[list[Hit], str]:
    """Hybrid search. Returns (hits, "hybrid" | "keyword")."""
    index = get_index()
    qvec = None
    if index.tag and index.tag in llm.available_embedding_tags():
        key = (index.tag, query.strip().lower())
        qvec = _query_cache.get(key)
        if qvec is None:
            result = await llm.embed([query], index.tag, query=True, timeout=6.0)
            if result:
                qvec = result[0][0]
                if len(_query_cache) > 500:
                    _query_cache.clear()
                _query_cache[key] = qvec
    return index.search(query, k, kinds, qvec), "hybrid" if qvec else "keyword"


def dump_documents(docs: list[Doc]) -> list[dict]:
    return [asdict(d) for d in docs]
