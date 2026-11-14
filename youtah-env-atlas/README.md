# YOUtah Environmental Atlas: impact simulator package

A drop-in environmental pivot for YOUtah. It covers proposed Utah data centers, a "drop a project" tool and legislation levers, all running through one sourced impact engine (Python). The results appear as MapLibre overlays, an Impact Panel and a one-page legislative briefing. Gemini only extracts parameters from text and explains results; it never produces numbers.

Design: `docs/design.md` (live version: https://claude.ai/artifact/GzZ8R2a4VEku8jMgxyHxwq) · Research and email guidance: `docs/research_notes.md`

## What is real and what you still fetch

| Ready now (in `static/atlas/`) | Source |
| --- | --- |
| `utah_counties.geojson`, `utah_boundary.geojson` | US Census counties (plotly/datasets), with engine results joined by county |
| `gsl_reference.geojson` | Natural Earth 10m lakes. A generalized outline, **not** the current shoreline |
| `projects.geojson` | 10-project registry with engine results. Coordinates are **approximate** |
| `gsl_playa_scenarios.geojson` | Extra exposed lakebed for 4 scenarios. Area-equivalent band, **illustrative** |
| `by_basin.json`, `scenario_totals.json`, `manifest.json` | Engine outputs and provenance |

| Fetch on your machine (`scripts/fetch_layers.py`) | Output |
| --- | --- |
| `gbif` | `gbif_hex.geojson` (species per H3 hex; no raw points) |
| `habitat` | `critical_habitat.geojson` (USFWS) |
| `firms` (needs `FIRMS_MAP_KEY`) | `firms_7d.geojson` |
| `perimeters` | `fire_perimeters.geojson` (NIFC WFIGS) |
| `tri` | `tri_facilities.geojson` (EPA TRI) |
| `basins` | `wbd_huc8.geojson` (USGS WBD with a basin crosswalk; review the assignments) |

Tile overlays that load straight from providers (opt-in toggles in `layers.js`): GBIF density, FEMA NFHL flood zones, USGS WBD basins, NASA FIRMS (with key).

These government endpoints could not be reached from the environment where this package was built, so none of the fetch or tile URLs are tested. Run `python scripts/check_sources.py` first; it pings all 72 catalogued sources and writes `data/sources_status.json`.

## Quick start (standalone)

```bash
pip install -r requirements-atlas.txt
python -m pytest -q                       # 10 tests
python scripts/dev_server.py              # then open:
#   http://localhost:8000/atlas/demo.html                      map + layer toggles + Impact Panel
#   http://localhost:8000/atlas/briefing.html                  one-page legislative briefing (print to PDF)
#   http://localhost:8000/atlas/pilots/stratos_who_pays.html   Stratos benefits/costs pilot
export GEMINI_API_KEY=...                 # enables "Plain-language summary" and the Legislation tab
python scripts/fetch_layers.py all        # biodiversity, wildfire, pollution, basins
python scripts/build_static_layers.py     # rebuild engine-derived layers after editing the registry
```

## Integrate into YOUtah

1. Copy `backend/intelligence/{impact_engine,gemini_bridge,overlays}.py`, `backend/routes/atlas_impact.py`, `static/atlas/`, `frontend/atlas/`, `scripts/`, `data/`.
2. Backend:
   ```python
   from backend.routes.atlas_impact import router as impact_router
   app.include_router(impact_router)
   app.mount("/static", StaticFiles(directory="static"), name="static")   # if not already mounted
   ```
   If your package root isn't `backend`, change the three `from backend.intelligence...` imports in `atlas_impact.py`.
3. Frontend, on your existing MapLibre map:
   ```js
   import { addAtlasLayers, setGroupVisibility, setTileOverlay } from './atlas/layers.js';
   import { ImpactPanel } from './atlas/impactPanel.js';   // + <link rel="stylesheet" href="./atlas/impactPanel.css">
   map.on('load', async () => {
     await addAtlasLayers(map, { base: '/static/atlas', visible: ['reference', 'lake', 'projects'] });
     new ImpactPanel(document.getElementById('impact-panel'), { map, api: '/api/atlas', briefingUrl: '/atlas/briefing.html' });
   });
   ```
   Layer groups: `reference, water, lake, biodiversity, wildfire, pollution, projects`. Labels need `glyphs` in your style (MapTiler styles have them).

## API

| Endpoint | Body | Returns |
| --- | --- | --- |
| `GET /api/atlas/projects` | — | Registry, including size options and published figures with source types |
| `POST /api/atlas/impact` | `{project_ids, custom[], levers{}, branch, scale, sizes{}, explain}` | Per-project and total ranges, `by_basin`, lever log, factors |
| `POST /api/atlas/overlays` | same | GeoJSON for scenario project rings and the playa band |
| `POST /api/atlas/extract/bill` | `{text}` | Levers with quotes, not-modeled provisions, `levers_dict` |
| `POST /api/atlas/extract/project` | `{text}` | Project fields with quotes |

`branch`: `built` (ignores design levers) · `conditions` · `scaled` (MW × `scale`) · `not_built` (zeros, plus "unknown, not zero" relocation note).

## Before showing this to anyone

- [ ] `check_sources.py`: fix or drop any failing source.
- [ ] Recheck registry facts in `impact_engine.REGISTRY` (sizes and water filings changed several times in 2026), then rebuild the static layers.
- [ ] Replace placeholder baselines with Division of Water Rights / Water Resources data, then set `baseline_status` in `manifest.json`. Until then the briefing is watermarked "Draft".
- [ ] Fill `baseline_consumptive_af` per project (current use of the land and rights converted) to enable the net-change test.
- [ ] Review `BASIN_KEYWORDS` in `fetch_layers.py` against the fetched HUC8 names.

## Known limits

Engine values are estimates from published factor ranges, not measurements; the high end stacks every worst-case input. Unknown cooling or power choices widen the ranges (for example, Creekstone's central estimate assumes on-site gas with wet cooling because its power plan isn't published). Health, economic and relocation effects are not modeled; the Stratos pilot shows the published, contested figures with their sources.
