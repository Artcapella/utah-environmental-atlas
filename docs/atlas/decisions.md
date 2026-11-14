# Environmental Atlas pivot: decisions (2026-11-14)

Design doc: https://claude.ai/artifact/GzZ8R2a4VEku8jMgxyHxwq (copy: `docs/atlas/design.md`). Goal: inform Utah policymakers how proposed legislation would affect the environment, with water and data centers first.

| Decision | Where it lives in the app |
| --- | --- |
| **Audience.** Legislature primary (statewide rules). Secondary: protestants in State Engineer water-right proceedings (citation export), county commissions (zoning; county drill-down), Divisions of Water Rights / Water Resources (data partners). | Briefing (`/briefing`); Impact tab › Copy / Download citation; briefing "Scope" county filter; `public/atlas/data/context.json` |
| **Legal context.** HB60 (2026) narrowed State Engineer discretion; county moratoria capped at 180 days; MIDA holds jurisdiction at Stratos. | Impact tab › Who decides; briefing "Decision context" box; Legislation tab note |
| **Committees.** Natural Resources, Agriculture and Environment Interim owns the data center impact study; Economic Development and Workforce Services opened a bill file defining large-scale data centers; Revenue and Taxation's role in incentives still to be checked. | `context.json` (`unconfirmed: true` on Revenue and Taxation) |
| **Scenario branches.** Built as planned, built with conditions, delayed/scaled down, not built here. "Not built" relocation impacts are unknown, not zero. | `backend/atlas/engine.py` `BRANCHES`; panel branch buttons; briefing scenario select |
| **Source-type tags** on every published figure: Government, Developer, Independent academic, Advocacy-commissioned, Derived. No net score, no dollars-vs-deaths netting. | `engine.SOURCE_TYPES`; `.ip-tag` outlines (dashed, double, dotted, heavy); briefing tags |
| **Net change vs current land use** (EO 2026-03) needs baseline consumptive use of converted rights: first data request to Water Rights. | `Project.baseline_consumptive_af`; "Cannot test" message until filled |
| **Briefing.** Statewide → basin → project; three columns (developer/agency says, engine estimate, highest on record); one-page print; watermarked "Draft: placeholder baselines" until agency data is loaded. | `public/atlas/briefing.html`; watermark reads `manifest.json` `layers.baseline_status.all_basins` |
| **Engine.** Hybrid: Gemini extracts and narrates under a number guard; deterministic Python factor model computes ranges. Unknown cooling: central closed-loop, high evaporative. Unknown on-site gas: central gas. | `backend/atlas/engine.py`, `backend/atlas/gemini.py` (`ungrounded_numbers`) |
| **Stratos pilot** ("who pays") kept unchanged. | `public/atlas/pilots/stratos_who_pays.html` (byte-identical to the package and `references/`) |
| **Endpoints.** `GET /api/atlas/projects`; `POST /api/atlas/impact`, `/overlays`, `/extract/project`, `/extract/bill`. | `backend/atlas/router.py` |

## Added from `references/`

- **Permit pipeline** (`utah-permit-pipeline.html`): five gates per project (land use, water right, air, water quality, construction), who decides, gaps, sources, dated events and open decisions. Six projects outside the engine registry use town-level coordinates. Data: `public/atlas/data/permits.geojson`.
- **Basin water risk** (`utah-water-planner-v3.html`, superseding the leadership planner and risk map): weighted score, dry-year supply, year filter, junior-curtailment flag, and lenses for developer says / rights / highest on record, plus an engine lens tied to the live scenario so levers move basin scores. **Basin baselines are invented placeholders** until Division data arrives. Data: `public/atlas/data/basin_risk.json`.
- Scale anchors: Utah generating capacity 10,277 MW (EIA 2024) and the Great Salt Lake need of about 800,000 AF/yr (Strike Team), both as cited in the research notes.

## Open items

- Replace placeholder basin baselines and set `baseline_status` in `manifest.json` (re-run `scripts/atlas/build_static_layers.py`, which overwrites it).
- Fill `baseline_consumptive_af` per project.
- Confirm Revenue and Taxation's role.
- Run `scripts/atlas/check_sources.py` and `scripts/atlas/fetch_layers.py` on a machine with normal internet (biodiversity, wildfire, pollution overlap flags).
- Re-check registry facts against the permit pipeline (e.g. Red Butte's ~1,900 AF/yr application estimate; Summit Ridge 20 vs 100 MW).
