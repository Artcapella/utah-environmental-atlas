# Research notes carried over from the chats and the email thread (Nov 2026)

These are summaries of earlier research, not independently re-verified. Figures for individual projects come from 2026 news and county filings and change often.

## 1. USACE data available for Utah (first chat)

Most USACE work in Utah is handled by the Sacramento District (office SPK; Bountiful and St. George field offices). Most services filter by state code UT or FIPS 49.

- **National Inventory of Dams**: `https://nid.sec.usace.army.mil/api/query?sy=@stateKey:UT`. Location, size, purpose, hazard, inspection, storage. Also an ArcGIS feature service.
- **National Structure Inventory**: building-level exposure data (GeoJSON by county or bbox; state GeoPackage).
- **National Levee Database**: levees.sec.usace.army.mil; sparse in Utah.
- **CWMS Data API**: time series, locations, ratings, forecasts; read without a key, filter office SPK; thin Utah coverage.
- **FUDS**: Utah SGID copy at `services1.arcgis.com/99lidPhWCzftIe9K/.../FUD/FeatureServer/0` (HIFLD Open was deactivated Aug 26, 2025).
- **RIBITS**: wetland mitigation banks and credits.
- **Gap**: no public API for Section 404 permits or jurisdictional determinations. Use public notices or FOIA.

## 2. Water use and new-demand risk views (second chat)

The use side comes from the Utah Division of Water Resources: M&I use, water-related land use, water budgets, and culinary supplier boundaries. Rights and distribution come from the Division of Water Rights: points of diversion, measurement stations, and the distribution network under prior appropriation. USACE supplies storage and exposure.

Five views: (1) current-use map by water system, (2) basin water budget, (3) storage and stress overlay (NID), (4) new-demand risk map (pending applications vs headroom, junior-right share, storage buffer, M&I trend), (5) scenario tester. Gaps: bulk pending applications, a 1–2 year lag in M&I data, growth projections (Kem C. Gardner Institute), and no 404 API.

## 3. Proposed data centers (third and fourth chats)

| Project | County | Size / status | Water figures (AF/yr) |
| --- | --- | --- | --- |
| Stratos / Wonder Valley | Box Elder | 9 GW full; county approved May 2026; first phase reported as up to 1.5 GW (governor) or 3 GW (health report) | Dev: ~1,215 diverted, ~987 net depletion. Rights: ~3,000 purchase + ~10,000 contract. DNR director: ~1,900. UCE: ~6,100 (gas engines, converted). Independent: ~50,000 (combined cycle); BYU ecologist ~100,000 |
| Joule campus | Millard | 455 MW Phase 1 under construction; 4,000+ MW | Rights ~10,000; closed-loop halls; gas generators use some water |
| Creekstone Delta Gigasite | Millard | 220 MW Phase 1; 10 GW planned | Dev: up to 2 AF per 100 MW (≤200 at 10 GW) |
| Antelope (Pronghorn) | Iron | 1.5 GW + gas plant; permit June 2026 | 10.8 operating (other filings 3.1–12.75); basin fully appropriated |
| Red Butte (BrightNight) | Iron | 1.5 GW; held by county moratorium | None published |
| Nine Mile (Energence) | Duchesne | ~400 MW; permits April 2026 | None; produced-water recycling |
| CyrusOne at Dugway | Tooele | 1,000 MW proposed | None; water-free cooling commitment |
| Tract Pole Canyon / Pony Express | Utah (Eagle Mountain) | 1,700 + 120 MW; 2028 | None published |
| QTS Eagle Mountain | Utah | Under construction | Closed-loop, one-time fill (not in registry: size unknown) |
| Summit Ridge (DCPC) | Utah (Santaquin) | 20 MW approved; 500 MW JV | None ("hardly anything") |
| BluSky Nephi | Juab | 9.3 MW | None |

HB 76: data centers >10,000 sq ft drawing ≥75 AF/yr report to the Division of Water Rights; reports are published online and the first actual use is expected around Sept 2027. The Great Salt Lake Strike Team estimates the lake needs ~800,000 AF/yr more inflow.

## 4. Email thread guidance (Madisyn Johnson, Nov 14, 2026)

**Audience.** The Legislature is primary: its interim committees, with the Divisions of Water Rights and Water Resources as technical partners. HB60 (2026) limits what the State Engineer can weigh. Counties' moratoria are capped at 180 days, and MIDA holds jurisdiction at Stratos. Speaker Schultz asked for analysis of the appropriate scale and water impacts. Use neutral decision-support framing.

**Comparison design.**
- Four branches: built as planned, built with conditions, delayed or scaled down, not built here. "Not built" requires choosing what happens instead; relocation impacts are unknown, not zero.
- Show net change against current land use: Stratos converts agricultural rights, and the developer claims less use than current agriculture. Diversion is not consumption. The baseline is the first data to get from Water Rights.
- Source tags (government, developer, independent, advocacy-commissioned), ranges, "not quantified", and no single score or dollars-versus-deaths netting.

**Stratos environmental figures (all contested).**
- NRDC/EmPower: 5–45 premature deaths and $75–690M a year at 9 GW; 1.6–15 deaths and $25–230M a year at 3 GW; >80% of damages outside Utah. Not peer-reviewed, and the developer disputes it.
- Utah Clean Energy: +55–75% to state climate emissions.
- USU professor: heat +5°F by day and up to +28°F at night (rough).
- FoGSL: a nearby wetland lost 80% of its spring flow to pumping (an existing condition, not a project effect).

**Economics.**
- Creekstone (government projection): $344M state revenue, $333M county wages, 106 jobs.
- Stratos (developer claim): ~10,000 construction jobs, 2,000 permanent jobs.
- Property tax incentives are capped around 60% of new county revenue (80% max). Depreciation makes the tax base volatile.

**Data to obtain.** See `docs/source_catalog.csv`:
- Water Rights POD (check for a priority-date field) and the Utah Water Use Program for M&I trends;
- ask the Divisions whether basin water budgets exist;
- HB 76 reports and water-right application records (e.g. a55167);
- DAQ air permits (69 gas engines permitted for a Millard data center);
- NRCS Water Supply Outlook, the DWRe climate report, the 2026 State Water Plan draft;
- the Gardner Institute, U of U property-tax research, and Brookings via Sutherland;
- county ordinances (Iron 2026-13, Cache 2026-32), the Server Country tracker and HB60 coverage.

The Stratos "who pays" pilot is in `frontend/atlas/pilots/stratos_who_pays.html`, unchanged.
