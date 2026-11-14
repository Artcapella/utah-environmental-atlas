# Utah Environmental Atlas — Impact Simulator Pivot

Design baseline: 14 Nov 2026 · Live, commentable version: https://claude.ai/artifact/GzZ8R2a4VEku8jMgxyHxwq

## Decisions

Build one impact engine with three ways in, inside the existing YOUtah map. Every number comes from a sourced formula. Gemini only reads proposals or bills and explains the results.

| Question | Decision | What it means for the build |
| --- | --- | --- |
| Audience | The Legislature first; protestants, county commissions and the Division of Water Rights second | Plain-language summary on top, "show the math" underneath, ranges rather than single numbers |
| Time | 2 hours, map framework already built | Cached GeoJSON instead of live ingestion, a factor engine instead of a trained model, one panel |
| Engine | Hybrid | Gemini turns text into parameters, Python computes the impacts, Gemini narrates only what Python returns |
| Scenarios | Proposed data centers, drop a project, legislation | All three feed one engine |
| Branches | Built as planned / built with conditions / delayed or scaled down / not built here | "Not built" is not zero: relocation impacts are unknown, and the panel says so |

## Audiences and goals

| Goal | Who decides | Who uses the tool | View | Output |
| --- | --- | --- | --- | --- |
| Statewide rule change (caps, thresholds, incentives, MIDA authority) | Legislature | Legislators, committee staff, the public | Legislative briefing | One-page PDF with its data limits |
| Contest or shape one project's water right | State Engineer, on the legal record | Protestants and their consultants | Project detail with "show the math" | Citation export |
| Protect one county from future projects | County commission, through zoning | Commissioners and residents | County/basin drill-down | One-page export filtered to the county |
| Better baseline data | Divisions of Water Rights and Water Resources | Agency staff as data partners | — | Replaces placeholder baselines |

The State Engineer is secondary: every water-right change passes through that office, even for MIDA projects, but each application is decided on its legal record, so a dashboard counts only if someone enters it as evidence. HB60 (2026) also narrowed the factors the State Engineer can weigh; only the Legislature can change that.

Committees: Natural Resources, Agriculture and Environment Interim owns the data center study on water, air and wildlife (passed unanimously May 20, 2026; the State Engineer presented to it Aug 19). Economic Development and Workforce Services opened a bill file to define a large-scale data center. Revenue and Taxation's role in incentives still needs checking. Bills would come in the 2027 General Session.

Counties are the weakest audience for a statewide tool: moratoria are capped at 180 days, Box Elder's does not cover Stratos (MIDA holds jurisdiction), and basins cross county lines.

## How it fits together

Three inputs (proposed projects, a dropped project, legislation → Gemini extract → user confirms levers) form one Scenario: projects plus levers plus a branch. The impact engine turns it into ranges that drive the map layers, the Impact Panel and the Gemini explanation, which is number-checked against the engine output.

## Screen design

The existing map gets one right-hand Impact Panel (`frontend/atlas/impactPanel.js`).

- Tabs: **Proposed** (checklist of registry projects, size options per project, All/None), **Drop a project** (set MW, cooling, gas, drains-to-GSL, then click the map), **Legislation** (paste bill text → levers with quotes → confirm each).
- Branch selector with the four branches.
- Plain-language summary (Gemini, number-guarded).
- Six rows: Water, Great Salt Lake and dust, Air and climate (computed, with range bars), and Biodiversity, Wildfire, Pollution (overlap flags).
- Water row shows **Developer or agency says / Engine estimate / Highest on record** side by side, every published figure with a source-type tag (Government, Developer, Independent academic, Advocacy-commissioned, Derived), and the net-change test against current land use (EO 2026-03 principle).
- "Show the math" expands factors and per-project assumptions; "Copy citation" copies inputs, factors and sources as text.

## Legislative briefing view

`frontend/atlas/briefing.html`: statewide, then basin, then project, printed to one page with a fixed Data limits box. It is watermarked "Draft: placeholder baselines" until `static/atlas/manifest.json` marks basin baselines as agency data. Framing: "would" and "estimate", never "will" or "threat"; the engine high is an upper bound, not a forecast; no recommendations and no net score.

## Data layers

| Theme | Layer | Status in this package |
| --- | --- | --- |
| Reference | Utah counties, Utah boundary | Built (`static/atlas/`) |
| Great Salt Lake | Reference outline (Natural Earth) | Built; generalized, not current shoreline |
| Dust | Extra exposed lakebed per scenario | Built; illustrative area-equivalent band |
| Water | Computed use by county; projects with results | Built |
| Water | WBD HUC8 basins + basin crosswalk | `scripts/fetch_layers.py basins`; tiles in `layers.js` |
| Flood | FEMA NFHL | Tile overlay in `layers.js` |
| Biodiversity | GBIF species per H3 hex; density tiles | `fetch_layers.py gbif`; tiles in `layers.js` |
| Biodiversity | USFWS critical habitat | `fetch_layers.py habitat` |
| Wildfire | FIRMS detections, NIFC perimeters | `fetch_layers.py firms perimeters` (FIRMS needs a free key) |
| Wildfire | USFS Wildfire Hazard Potential | Manual raster download (see sources) |
| Pollution | EPA TRI facilities | `fetch_layers.py tri` |

## Impact engine

`backend/intelligence/impact_engine.py`. Every output is (low, central, high).

- Site water: AF = (MW_fac / PUE) × 8760 × LF × 1000 × WUE / 1,233,482
- Gas plant water: AF = MW_fac × 8760 × LF × gal_per_MWh / 325,851
- GSL: Δh ≈ −D / 100,000 ft (D = net depletion AF/yr, only basins draining to the lake); playa ≈ 31,000 acres per ft
- Air: MWh × CO2 rate; MWh × heat rate × NOx limit
- Unknowns are ranges: unknown cooling = closed-loop central, evaporative high; unknown on-site gas = grid low, gas central/high; unknown power cooling = dry low, wet central/high.

| Factor | Low | Central | High | Source |
| --- | --- | --- | --- | --- |
| WUE evaporative (L/kWh) | 1.5 | 1.8 | 3.0 | Introl, aquaray |
| WUE closed-loop/dry | 0 | 0.04 | 0.2 | LBNL via VoxBooster; preprints.org review |
| PUE | 1.1 | 1.3 | 1.4 | Tetra Tech 2026 (US avg ~1.40) |
| Load factor | 0.6 | 0.8 | 0.95 | Assumption |
| NGCC wet cooling (gal/MWh) | 130 | 200 | 300 | UCS |
| NGCC dry cooling (gal/MWh) | 0 | 2 | 4 | UCS |
| CO2 NGCC (lb/MWh) | 771 | 800 | 832 | EPA Clean Power Plan rates |
| NOx limit (lb/MMBtu) | — | 0.0178 | — | EPA Table 3-29 |
| Heat rate (MMBtu/MWh) | 6.5 | 7.0 | 7.5 | Assumption |
| GSL ft per 100,000 AF/yr | 0.7 | 1.0 | 1.3 | Utah GSL water-budget study; ±30% assumed |
| Playa acres per ft | 25,000 | 31,000 | 35,000 | Derived from GSL area tables |

## Gemini's role

`backend/intelligence/gemini_bridge.py`. Extract (JSON schema, every field quoted) and Explain (server rejects any number not in the engine output, retries once). Bills map to a closed lever list: `cooling_required`, `max_wue`, `onsite_gas_allowed`, `power_cooling_required`, `gsl_offset_ratio`, `moratorium_counties`, `habitat_setback_km`, `reporting_threshold_af` (reporting changes what the state knows, not use). Anything else is shown as "Not modeled".

## Demo script (~4 min)

1. Stratos: developer says ~1,200 AF/yr; engine central ~40,000 (0–230,000), mostly gas-plant cooling; lake ~0.4 ft lower long-run. Highest on record: ~100,000.
2. All: ~130,000 AF/yr (0–520,000) vs 1,400 stated and 23,000 AF of rights.
3. HB 76 summary → `reporting_threshold_af = 75`: changes visibility, not use.
4. Mock dry-cooling bill → ~6,500 AF/yr, lake effect a few hundredths of a foot; air rows unchanged (the tradeoff).
5. Not built here → water stays in current use; relocation impacts unknown, not zero.

## Guardrails

Ranges always · stated vs computed vs rights side by side · overlaps are not harms · lake effect long-run and lake-draining only · grid power is not zero impact · GBIF shown only as hexes · coordinates approximate · no dollars-versus-deaths net total.
