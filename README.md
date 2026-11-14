# Utah Environmental Atlas

A map-first tool that shows Utah legislators how proposed data centers, and the bills that would regulate them, would affect the state's water, air and the Great Salt Lake.

Every number comes from a sourced, deterministic impact engine and is shown as a low / central / high range with its source type (Government, Developer, Independent academic, Advocacy-commissioned, Derived). AI models only read bills and proposals and explain results. They never produce figures.

**Audience.** The Legislature first, for statewide rules on caps, thresholds, incentives and MIDA authority. Secondary: protestants in State Engineer water-right proceedings, county commissions, and the Divisions of Water Rights and Water Resources as data partners. Read why in [docs/atlas/decisions.md](docs/atlas/decisions.md) and [docs/atlas/design.md](docs/atlas/design.md).

> **Placeholder data.** Basin water-risk baselines are invented until agency data loads. The briefing is watermarked "Draft" until `public/atlas/data/manifest.json` marks them as agency data. Project coordinates are approximate.

## How this differs from Comprehensive Utah

This repo grew out of [Comprehensive Utah](https://github.com/Artcapella/YOUtah), a discovery app for Utah newcomers built around events, places, food, skiing and trip planning. The Environmental Atlas keeps that app's map, live air-quality and weather feeds, and FastAPI/Supabase backend, but changes what the app is for:

| | Comprehensive Utah | Utah Environmental Atlas |
| --- | --- | --- |
| Who it's for | Newcomers and visitors | Legislators, committee staff, reviewers |
| Main question | What should I do in Utah today? | What would this data center or bill do to our water? |
| Homepage | Discovery map with events and places | Atlas map with projects, the lake, basins and permits |
| Output | Recommendations | Ranges with sources, a one-page briefing, a water screen |
| AI | Travel guide (OpenAI RAG) | Atlas assistant that moves the map and is checked against sources |

The tourist features still exist but are hidden. Pages carry `body.env-mode`: [public/assets/env-mode.css](public/assets/env-mode.css) hides elements marked `.tourist`, and an `ENV_MODE` flag in the page scripts skips events, food, personas, itineraries, promoters, ski and transit layers. Remove the class to get the old experience back.

## What's in the app

### The map (`/`)

The map is the main display. The panels, tables and chat all support it. Its **Impact** tab draws the findings on the map:

- Data-center rings sized by the engine's water estimate.
- A ghost ring with a "was → now" label when a lever changes a project.
- Permit-stage dots.
- The extra lakebed a scenario would expose.
- Basin risk bubbles.
- A headline card.

Panel tabs:

- **Projects**: the 10-project registry.
- **Legislation**: set levers by hand, or paste a bill or pick one from the library. Shows the result with the levers beside the result built as planned.
- **Basins**: the water-risk model, using placeholder baselines.
- **Permits**: a five-gate pipeline (land use, water right, air, water quality, construction) with events and open decisions.
- **Drop a project**: place a hypothetical project anywhere.
- **Who decides**: HB60, county moratoria and MIDA jurisdiction.

Every result is shown for four scenario branches: built as planned, built with conditions, delayed or scaled down, and not built here. "Not built here" doesn't mean zero impact: if the project moves elsewhere, its impacts there are unknown, and the app says so.

**Four-branch strip.** It docks over the map, and each card redraws the map for that branch.

**Sharing.** The URL updates as you work, so a link reproduces the scenario. For example:

```
/?impact&projects=all&branch=conditions&levers={"power_cooling_required":"dry"}
```

The map also keeps the live conditions layers: Utah DAQ monitors, NWS alerts and stations, the inversion ("smog lid") estimate, and 72-hour forecast fields.

### Other pages

| Page | What it is |
| --- | --- |
| `/briefing` | One-page legislative briefing that prints to PDF. It goes statewide → basin → project, with three columns: what the developer or agency says, the engine's estimate, and the highest figure on record. Use `?branch=` and `?county=` for a county drill-down. |
| `/screen` | Water screen for one proposal, for city councils, county commissions, water providers and state reviewers. It gives a first estimate, a check of the developer's claim, ways to use less water, red flags, questions for the developer, a hydrology study scope, conditions of approval and a memo. Open it from "Screen ↗" in the Impact tab or a project popup, for example `/screen?project=stratos&mw=3000`. |
| `/atlas/pilots/stratos_who_pays.html` | The Stratos "who pays" pilot, unchanged. |
| `/about`, `/inversion` | Air-quality trends and the inversion explainer. |

### Atlas assistant and guided tour

- **Assistant** (`POST /api/atlas/ask`). Tries a Gemini tool agent first, then OpenAI, then quotes source passages with no model. Each reply carries map actions: select projects, apply a bill, fly to a place, toggle layers, open the branch strip, or start the tour. If a reply contains a number that isn't in a source or tool result, the assistant rewrites it once. Numbers it still can't trace are listed in `unverified_numbers`.
- **Guided tour** ([public/assets/atlas-tour.js](public/assets/atlas-tour.js)). Fixed stops written for a legislator. Each stop sets up the map completely, then points to a figure on the map or in the panel. No model is involved, so the tour can't quote a wrong number. Start it from "Show me around" or from the assistant.

## Architecture

```text
public/map.html + public/assets/atlas-*.js   MapLibre map, Impact panel, tour, branch strip
public/atlas/                                 briefing, water screen, pilot, static data layers
backend/atlas/
  engine.py        deterministic factor model → (low, central, high) ranges per branch
  gemini.py        extracts levers/proposal fields with quotes; narrates under a number guard
  assistant.py     tool-using chat agent that returns map actions
  knowledge.py     source-backed index the assistant answers from
  bills.py         bill library mapped onto engine levers
  comparison.py    four-branch comparison
  router.py        /api/atlas/* routes
backend/providers/ live NWS, Utah DAQ, UDOT, UTA and other adapters (normalized Pydantic models)
supabase/          Postgres/PostGIS schema, RLS, migrations
```

### API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/atlas/projects` | Project registry with engine results |
| `POST /api/atlas/impact` | Run the engine for projects, branch and levers |
| `POST /api/atlas/overlays` | Map overlays for a scenario |
| `POST /api/atlas/compare` | Four-branch comparison |
| `GET /api/atlas/bills` | Bill library. Real measures are summaries of coverage and agency documents, not bill text. Mock bills are labelled as mock. |
| `POST /api/atlas/extract/project`, `/extract/bill` | Gemini extraction with quotes (returns 503 without `GEMINI_API_KEY`) |
| `POST /api/atlas/ask`, `GET /api/atlas/ask/status` | Assistant, and which models are available (no credentials returned) |

## Run locally

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env.local
uvicorn app:app --reload
```

Without keys, the map, engine, briefing, screen, tour and source-quoting assistant all work. Optional keys, set in `.env.local` or in Vercel's environment variables:

| Variable | Enables |
| --- | --- |
| `GEMINI_API_KEY` (`GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`) | Bill and proposal extraction, narration, and the assistant's first-choice agent |
| `OPENAI_API_KEY` or `AI_GATEWAY_API_KEY` | Assistant fallback |
| `NEXT_PUBLIC_MAPTILER_KEY` | 3D terrain basemap. This is a browser key, so restrict its allowed origins in MapTiler. |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | Live database (see below) |
| `CRON_SECRET` | Scheduled ingest routes |

Never put a secret in a `NEXT_PUBLIC_*` variable.

### Tests

```bash
.venv/Scripts/python.exe -m pytest      # Windows; use .venv/bin/python elsewhere
node --test tests/*.test.cjs            # front-end tests (tour, water screen, basin risk, …)
```

## Data

- **Static layers** are in `public/atlas/data/`: projects, counties, the lake outline, playa scenarios, basin risk, permits, and the decision context. `backend/atlas/data/` holds the lake outline for the API.
- **Rebuild after editing the registry:** `python scripts/atlas/build_static_layers.py`. This overwrites `manifest.json`.
- **Rebuild the assistant's index** after changing sources, projects, bills or engine factors: `python scripts/atlas/build_knowledge.py`. Use `--check` to report staleness; a test fails when the shipped index is stale. Placeholder basin numbers are deliberately left out of the index.
- **Overlap layers** (biodiversity, wildfire, pollution): `python scripts/atlas/fetch_layers.py all`.
- **Check the 72 catalogued sources:** `python scripts/atlas/check_sources.py`. The catalog is [docs/atlas/source_catalog.csv](docs/atlas/source_catalog.csv), and the research behind the figures is [docs/atlas/research_notes.md](docs/atlas/research_notes.md).

### Open data items

- Replace the placeholder basin baselines with Division data, then set `baseline_status` in `manifest.json`.
- Fill `baseline_consumptive_af` per project, so the app can compare a project's water use with the converted rights' current use (EO 2026-03).
- Confirm the Stratos water request and cooling type used by the water screen.
- Decide whether the water screen's coefficients should match the engine's.
- Confirm the Revenue and Taxation committee's role.

The full list is in [docs/atlas/decisions.md](docs/atlas/decisions.md#open-items).

## Supabase

1. Create a project and fill in the `SUPABASE_*` keys from **Project Settings → API Keys**. The legacy `NEXT_PUBLIC_SUPABASE_*` / `SUPABASE_SERVICE_ROLE_KEY` names still work.
2. Run `npx supabase login && npx supabase link --project-ref <ref>`, then `npx supabase db push`.
3. `GET /api/health` should report `"supabase_status": "ok"`. A status of `schema_missing` means the push hasn't run.

Reads use the publishable key, so they only see what the RLS policies make public. Writes and ingestion use the secret key, which stays server-side. Put schema changes in `supabase/migrations/` (`npx supabase migration new <name>`).

## Air-quality intelligence (carried over)

`/api/intelligence` serves an **Outdoor Comfort** nowcast: a three-class PM2.5 band at the nearest DAQ station, a few hours ahead. Training is offline (`requirements-ml.txt`, `scripts/backfill_aqs_history.py`, `scripts/train_outdoor_comfort.py`). The deployed model is portable JSON. If no model has passed the training gate, the API serves a conservative fallback and `/api/intelligence/model-status` says why. Daily DAQ snapshots are collected by `GET /api/cron/ingest`.

## Deploy

Import the repo in Vercel; it detects `app.py` and FastAPI. Add the environment variables for Production and Preview. [vercel.json](vercel.json) maps `/` to the map and `/briefing` and `/screen` to the atlas pages, and schedules the ingest crons.

## Source and safety rules

- Every published figure keeps its source URL, source type and date. Nothing is averaged across sources, and nothing gets a single net score.
- Show ranges, not single numbers. An unknown stays visibly unknown. Unknown cooling defaults to closed-loop for the central estimate and evaporative for the high one.
- Providers are fetched by server routes, never from the browser. No secret key reaches the browser.
- The inversion height is an estimate, not a safety clearance.

## Team

- H Dunn
- Diane Hoskins
- Maddie Johnson
- Robin Murillo

## License

[MIT](LICENSE)
