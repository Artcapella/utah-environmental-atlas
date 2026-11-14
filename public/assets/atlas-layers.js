// Utah Environmental Atlas — MapLibre overlay layers for the YOUtah map (public/map.html).
// Loaded by /assets/map-atlas.js, which registers each group as a layer in the map's Layers tab.
//
// Static files come from /atlas/data (built by scripts/atlas/build_static_layers.py; live-source
// files by scripts/atlas/fetch_layers.py). Missing files are skipped silently, so the map works
// before every fetch has run. Tile overlays load straight from the providers' servers.
// addAtlasLayers is idempotent per style: call it again after map.setStyle() to restore the layers.

export const ATLAS_BASE = '/atlas/data';

const C = {
  water: '#2b6f9e', lake: '#3d8fc4', playa: '#c8a165', habitat: '#3f7d4e', fire: '#d0461c',
  perimeter: '#a33a1f', pollution: '#7a3f8f', ink: '#12324a', county: '#566b74',
};

// group -> layer ids (used by setGroupVisibility and the legend)
export const LAYER_GROUPS = {
  reference: ['atlas-boundary-line', 'atlas-counties-line'],
  water: ['atlas-counties-fill', 'atlas-basins-line', 'atlas-basins-label', 'atlas-wbd-tiles', 'atlas-fema-tiles'],
  lake: ['atlas-gsl-fill', 'atlas-gsl-line', 'atlas-playa-fill', 'atlas-playa-line'],
  biodiversity: ['atlas-gbif-hex', 'atlas-gbif-tiles', 'atlas-habitat-fill', 'atlas-habitat-line'],
  wildfire: ['atlas-perimeters-fill', 'atlas-firms-points', 'atlas-firms-tiles'],
  pollution: ['atlas-tri-points'],
  projects: ['atlas-projects-circle', 'atlas-projects-label', 'scenario-playa-fill', 'scenario-projects-circle'],
  permits: ['atlas-permits-circle', 'atlas-permits-symbol'],
  basinrisk: ['atlas-basinrisk-circle', 'atlas-basinrisk-label'],
};

// Permit pipeline tiers (references/utah-permit-pipeline.html) and basin-risk categories (water planner v3)
export const TIER_COLORS = { t1: '#8e1b3a', t2: '#d2622f', t3: '#e2a43a', t0: '#8a9ba1' };
export const RISK_CATS = [['Low', 0, '#5fae9f'], ['Watch', 40, '#e2a43a'], ['High', 55, '#d2622f'], ['Critical', 70, '#8e1b3a']];

export const LEGENDS = {
  water: { title: 'Computed water use by county (AF/yr, central, all proposed built)',
    stops: [[0, '#f2f5f6'], [1000, '#cfe1ec'], [10000, '#8fbad6'], [50000, '#4a8bb8'], [100000, '#1f5b85']],
    note: 'Engine estimate, not measured use. Baselines are placeholders until Division data is loaded.' },
  lake: { title: 'Great Salt Lake', items: [['Reference outline (Natural Earth)', C.lake], ['Extra exposed lakebed, scenario (illustrative band)', C.playa]],
    note: 'The band has the estimated area but not the real shape; exposure follows bathymetry.' },
  biodiversity: { title: 'Biodiversity', items: [['GBIF species per hex (darker = more)', C.habitat], ['USFWS critical habitat', '#6aa77a']],
    note: 'Occurrence counts reflect survey effort as well as biodiversity.' },
  wildfire: { title: 'Wildfire', items: [['Active detections, last 7 days (FIRMS)', C.fire], ['Perimeters since 2020 (NIFC)', C.perimeter]] },
  pollution: { title: 'Pollution', items: [['TRI reporting facilities', C.pollution]], note: 'Proximity is not exposure.' },
  permits: { title: 'Data center permit pipeline', items: [['Under construction or air-permitted', TIER_COLORS.t1], ['Approved locally, state permits pending', TIER_COLORS.t2],
    ['Proposed, on hold or in negotiation', TIER_COLORS.t3], ['Not classified', TIER_COLORS.t0]],
    note: 'Hollow ring = not in the impact engine (town-level location). "Not found" means no filing was found, not that none exists.' },
  basinrisk: { title: 'Basin water risk (PLACEHOLDER baselines)', items: RISK_CATS.map(([n, min, c]) => [`${n} (score ${min}+)`, c]),
    note: 'Basin supply, junior-right share and storage are invented placeholders until Division of Water Rights / Water Resources data is loaded. Not a finding.' },
  projects: { title: 'Proposed data centers', items: [['Drains to Great Salt Lake', C.water], ['Other basin', '#8a6d3b']],
    note: 'Circle area = engine central water estimate. Locations are approximate.' },
};

// ---------------------------------------------------------------- helpers
const probed = new Map();   // url -> Promise<boolean>; probe once per page, not per style reload
function exists(url) {
  if (!probed.has(url)) probed.set(url, fetch(url, { method: 'HEAD' }).then((r) => r.ok, () => false));
  return probed.get(url);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function addGeo(map, id, data) {
  if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data });
}
function addLayer(map, def, beforeId) {
  if (!map.getLayer(def.id)) map.addLayer(def, beforeId);
}
function arcgisTiles(url) {
  return `${url}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image`;
}
const EMPTY = { type: 'FeatureCollection', features: [] };

// ---------------------------------------------------------------- main
export async function addAtlasLayers(map, { base = ATLAS_BASE, firmsKey = null, beforeId, playaScenario = 'all_built',
                                            visible = ['reference', 'lake', 'projects'], font = ['Noto Sans Regular'] } = {}) {
  const f = (name) => `${base}/${name}`;

  // Reference + engine layers (always shipped)
  addGeo(map, 'atlas-boundary', f('utah_boundary.geojson'));
  addGeo(map, 'atlas-counties', f('utah_counties.geojson'));
  addGeo(map, 'atlas-gsl', f('gsl_reference.geojson'));
  addGeo(map, 'atlas-playa', f('gsl_playa_scenarios.geojson'));
  addGeo(map, 'atlas-projects', f('projects.geojson'));
  addGeo(map, 'scenario-projects', EMPTY);
  addGeo(map, 'scenario-playa', EMPTY);
  addGeo(map, 'atlas-permits', f('permits.geojson'));
  addGeo(map, 'atlas-basinrisk', map.__atlasBasinRisk || EMPTY);   // filled by atlas-basin-risk.js

  // Live-source layers (only if fetch_layers.py has produced them)
  const optional = {
    'atlas-gbif': 'gbif_hex.geojson', 'atlas-habitat': 'critical_habitat.geojson', 'atlas-tri': 'tri_facilities.geojson',
    'atlas-firms': 'firms_7d.geojson', 'atlas-perimeters': 'fire_perimeters.geojson', 'atlas-basins': 'wbd_huc8.geojson',
  };
  const have = {};
  await Promise.all(Object.entries(optional).map(async ([id, file]) => {
    have[id] = await exists(f(file));
    if (have[id]) addGeo(map, id, f(file));
  }));

  // Tile overlays straight from providers (verify with scripts/check_sources.py)
  const tiles = {
    'atlas-gbif-tiles': ['https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?srs=EPSG:3857&style=classic.point&country=US', 'GBIF'],
    'atlas-fema-tiles': [arcgisTiles('https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer'), 'FEMA NFHL'],
    'atlas-wbd-tiles': [arcgisTiles('https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer'), 'USGS WBD'],
  };
  if (firmsKey) tiles['atlas-firms-tiles'] = [
    `https://firms.modaps.eosdis.nasa.gov/mapserver/wms/fires/${firmsKey}/?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=fires_viirs_snpp_7&STYLES=&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true`, 'NASA FIRMS'];
  for (const [id, [url, attribution]] of Object.entries(tiles)) {
    if (!map.getSource(id)) map.addSource(id, { type: 'raster', tiles: [url], tileSize: 256, attribution });
    addLayer(map, { id, type: 'raster', source: id, paint: { 'raster-opacity': 0.7 }, layout: { visibility: 'none' } }, beforeId);
  }

  // ---- styles
  addLayer(map, { id: 'atlas-counties-fill', type: 'fill', source: 'atlas-counties', paint: {
    'fill-color': ['step', ['get', 'water_central_af'], LEGENDS.water.stops[0][1],
      1000, LEGENDS.water.stops[1][1], 10000, LEGENDS.water.stops[2][1], 50000, LEGENDS.water.stops[3][1], 100000, LEGENDS.water.stops[4][1]],
    'fill-opacity': 0.55 } }, beforeId);
  addLayer(map, { id: 'atlas-counties-line', type: 'line', source: 'atlas-counties',
    paint: { 'line-color': C.county, 'line-width': 0.6, 'line-opacity': 0.6 } }, beforeId);
  addLayer(map, { id: 'atlas-boundary-line', type: 'line', source: 'atlas-boundary',
    paint: { 'line-color': C.ink, 'line-width': 1.6 } }, beforeId);

  addLayer(map, { id: 'atlas-gsl-fill', type: 'fill', source: 'atlas-gsl', paint: { 'fill-color': C.lake, 'fill-opacity': 0.35 } }, beforeId);
  addLayer(map, { id: 'atlas-gsl-line', type: 'line', source: 'atlas-gsl', paint: { 'line-color': C.lake, 'line-width': 1 } }, beforeId);
  addLayer(map, { id: 'atlas-playa-fill', type: 'fill', source: 'atlas-playa', filter: ['==', ['get', 'scenario'], playaScenario],
    paint: { 'fill-color': C.playa, 'fill-opacity': 0.75 } }, beforeId);
  addLayer(map, { id: 'atlas-playa-line', type: 'line', source: 'atlas-playa', filter: ['==', ['get', 'scenario'], playaScenario],
    paint: { 'line-color': '#8c6a35', 'line-width': 0.8, 'line-dasharray': [2, 2] } }, beforeId);

  if (have['atlas-basins']) {
    addLayer(map, { id: 'atlas-basins-line', type: 'line', source: 'atlas-basins', paint: { 'line-color': C.water, 'line-width': 1 } }, beforeId);
    addLayer(map, { id: 'atlas-basins-label', type: 'symbol', source: 'atlas-basins', minzoom: 7,
      layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-font': font }, paint: { 'text-color': C.water, 'text-halo-color': '#fff', 'text-halo-width': 1 } }, beforeId);
  }
  if (have['atlas-gbif']) addLayer(map, { id: 'atlas-gbif-hex', type: 'fill', source: 'atlas-gbif', paint: {
    'fill-color': ['interpolate', ['linear'], ['get', 'species'], 0, '#eef5ef', 20, '#a9cdb2', 100, '#5c9a6b', 400, C.habitat],
    'fill-opacity': 0.6, 'fill-outline-color': 'rgba(0,0,0,0.05)' } }, beforeId);
  if (have['atlas-habitat']) {
    addLayer(map, { id: 'atlas-habitat-fill', type: 'fill', source: 'atlas-habitat', paint: { 'fill-color': '#6aa77a', 'fill-opacity': 0.35 } }, beforeId);
    addLayer(map, { id: 'atlas-habitat-line', type: 'line', source: 'atlas-habitat', paint: { 'line-color': C.habitat, 'line-width': 1 } }, beforeId);
  }
  if (have['atlas-perimeters']) addLayer(map, { id: 'atlas-perimeters-fill', type: 'fill', source: 'atlas-perimeters',
    paint: { 'fill-color': C.perimeter, 'fill-opacity': 0.3, 'fill-outline-color': C.perimeter } }, beforeId);
  if (have['atlas-firms']) addLayer(map, { id: 'atlas-firms-points', type: 'circle', source: 'atlas-firms',
    paint: { 'circle-color': C.fire, 'circle-radius': 3, 'circle-opacity': 0.85 } }, beforeId);
  if (have['atlas-tri']) addLayer(map, { id: 'atlas-tri-points', type: 'circle', source: 'atlas-tri',
    paint: { 'circle-color': C.pollution, 'circle-radius': 3.5, 'circle-stroke-color': '#fff', 'circle-stroke-width': 0.8 } }, beforeId);

  const radius = ['interpolate', ['linear'], ['sqrt', ['max', ['coalesce', ['get', 'water_central'], 0], 1]], 0, 4, 100, 12, 250, 26];
  addLayer(map, { id: 'atlas-projects-circle', type: 'circle', source: 'atlas-projects', paint: {
    'circle-radius': radius, 'circle-color': ['case', ['get', 'gsl_basin'], C.water, '#8a6d3b'],
    'circle-opacity': 0.35, 'circle-stroke-color': ['case', ['get', 'gsl_basin'], C.water, '#8a6d3b'], 'circle-stroke-width': 1.5 } }, beforeId);
  addLayer(map, { id: 'atlas-projects-label', type: 'symbol', source: 'atlas-projects', minzoom: 5.5,
    layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-optional': true, 'text-font': font },
    paint: { 'text-color': C.ink, 'text-halo-color': '#fff', 'text-halo-width': 1.2 } }, beforeId);

  // permit pipeline: colour = tier; hollow ring = not modeled by the engine (town-level location)
  addLayer(map, { id: 'atlas-permits-circle', type: 'circle', source: 'atlas-permits', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 5, 9, 9],
    'circle-color': ['match', ['get', 'tier'], 't1', TIER_COLORS.t1, 't2', TIER_COLORS.t2, 't3', TIER_COLORS.t3, TIER_COLORS.t0],
    'circle-opacity': ['case', ['get', 'in_registry'], 0.95, 0],
    'circle-stroke-color': ['match', ['get', 'tier'], 't1', TIER_COLORS.t1, 't2', TIER_COLORS.t2, 't3', TIER_COLORS.t3, TIER_COLORS.t0],
    'circle-stroke-width': ['case', ['get', 'in_registry'], 1.5, 3] } }, beforeId);
  addLayer(map, { id: 'atlas-permits-symbol', type: 'symbol', source: 'atlas-permits', minzoom: 6.5,
    layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true, 'text-font': font },
    paint: { 'text-color': C.ink, 'text-halo-color': '#fff', 'text-halo-width': 1.2 } }, beforeId);

  // basin water risk: bubble size = counted demand, colour = score category (placeholder baselines)
  addLayer(map, { id: 'atlas-basinrisk-circle', type: 'circle', source: 'atlas-basinrisk', paint: {
    'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'demand']], 0, 10, 100, 20, 250, 40],
    'circle-color': ['step', ['get', 'score'], RISK_CATS[0][2], 40, RISK_CATS[1][2], 55, RISK_CATS[2][2], 70, RISK_CATS[3][2]],
    'circle-opacity': 0.55, 'circle-stroke-color': '#fff', 'circle-stroke-width': ['case', ['get', 'curtail'], 3, 1] } }, beforeId);
  addLayer(map, { id: 'atlas-basinrisk-label', type: 'symbol', source: 'atlas-basinrisk',
    layout: { 'text-field': ['concat', ['get', 'name'], '
', ['to-string', ['round', ['get', 'score']]], ['case', ['get', 'curtail'], ' · J', '']],
      'text-size': 11, 'text-font': font, 'text-allow-overlap': false },
    paint: { 'text-color': C.ink, 'text-halo-color': '#fff', 'text-halo-width': 1.4 } }, beforeId);

  // scenario overlays (filled by updateScenarioOverlays)
  addLayer(map, { id: 'scenario-playa-fill', type: 'fill', source: 'scenario-playa', paint: { 'fill-color': C.playa, 'fill-opacity': 0.85 } }, beforeId);
  addLayer(map, { id: 'scenario-projects-circle', type: 'circle', source: 'scenario-projects', paint: {
    'circle-radius': radius, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': C.ink, 'circle-stroke-width': 2 } }, beforeId);

  for (const g of Object.keys(LAYER_GROUPS)) setGroupVisibility(map, g, visible.includes(g));
  bindPopups(map);
  return { optionalLoaded: have };
}

export function setGroupVisibility(map, group, on) {
  for (const id of LAYER_GROUPS[group] || []) {
    if (!map.getLayer(id) || (on && id.endsWith('-tiles'))) continue;  // tiles are opt-in: setTileOverlay
    map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
}

// Tile overlays are opt-in (third-party servers): toggle them explicitly.
export function setTileOverlay(map, id, on) {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}

export function setPlayaScenario(map, scenario) {
  for (const id of ['atlas-playa-fill', 'atlas-playa-line'])
    if (map.getLayer(id)) map.setFilter(id, ['==', ['get', 'scenario'], scenario]);
}

// overlays = response of POST /api/atlas/overlays
export function updateScenarioOverlays(map, overlays) {
  map.getSource('scenario-projects')?.setData(overlays?.projects || EMPTY);
  map.getSource('scenario-playa')?.setData(overlays?.playa || EMPTY);
}

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
const projectPopup = (p) => `<b>${esc(p.name)}</b><br>${esc(p.county)} County · ${esc(p.basin)}<br>${fmt(p.mw)} MW${p.status ? ' · ' + esc(p.status) : ''}<hr style="margin:4px 0;border:0;border-top:1px solid currentColor;opacity:.25">
    ${p.not_built === true || p.not_built === 'true' ? 'Not built here: water stays in current use; relocation impacts unknown, not zero.' : `Engine water: <b>${fmt(p.water_central)}</b> AF/yr (range ${fmt(p.water_low)}–${fmt(p.water_high)})<br>
    Developer stated: ${fmt(p.stated_af)} · Rights: ${fmt(p.rights_af)} · Highest on record: ${fmt(p.published_high_af)}`}<br>
    <small>${String(p.id || '').startsWith('custom_') ? 'Dropped project (your scenario).' : 'Location approximate.'} Engine values are estimates.</small>`;
const GATE_NAMES = { land: 'Land use', water: 'Water right', air: 'Air permit', wq: 'Water quality', build: 'Construction' };
const STATUS_LABELS = { done: '✓ Done', inprogress: '▶ In progress', partial: '◐ Partly done', pending: '⋯ Pending', appealed: '⚖ Appealed',
  onhold: '⏸ On hold', withdrawn: '✕ Withdrawn', notfound: '? Not found', notsearched: '∅ Not searched', inferred: '≈ Inferred', na: '– N/A' };
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);   // MapLibre stringifies nested properties
const permitPopup = (p) => {
  const g = parse(p.gates) || {};
  return `<b>${esc(p.name)}</b><br>${esc(p.county)} County · ${esc(p.tier_label)}<br><small>Who decides land use: ${esc(p.decider_label)}</small>
    <table style="font-size:12px;margin-top:4px">${Object.entries(GATE_NAMES).map(([k, n]) => `<tr><td>${n}</td><td>${esc(STATUS_LABELS[g[k]] || g[k])}</td></tr>`).join('')}</table>
    <small>${p.in_registry === true || p.in_registry === 'true' ? 'Location approximate.' : `Not in the impact engine; ${esc(p.location)}.`} Latest source ${esc(p.as_of || 'n/a')}. Full notes and sources in the Impact tab › Pipeline.</small>`;
};
function bindPopups(map) {
  if (map.__atlasPopups || !window.maplibregl) return;
  map.__atlasPopups = true;
  // `under`: a layer drawn above this one; skip the popup when that layer was hit too (no double popups).
  const pop = (layer, html, under) => {
    map.on('click', layer, (e) => {
      if (window.YOUtah?.state?.pickMode || map.__atlasDropMode) return;
      if (under && map.getLayer(under) && map.queryRenderedFeatures(e.point, { layers: [under] }).length) return;
      new window.maplibregl.Popup({ maxWidth: '300px' }).setLngLat(e.lngLat).setHTML(html(e.features[0].properties)).addTo(map);
    });
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  };
  // Scenario rings sit on top of the static circles, so they take the click when a scenario is drawn.
  pop('scenario-projects-circle', projectPopup);
  pop('atlas-projects-circle', projectPopup, 'scenario-projects-circle');
  pop('atlas-counties-fill', (p) => `<b>${esc(p.name)} County</b><br>${p.projects} proposed project(s), all built as planned<br>Engine water: ${fmt(p.water_central_af)} AF/yr<br>Stated: ${fmt(p.stated_af)} AF/yr`, 'atlas-projects-circle');
  const lakebed = (p) => `<b>Extra exposed lakebed</b><br>${esc(p.branch)}: ~${fmt(p.playa_acres_central)} acres, lake ~${p.level_drop_ft_central} ft lower (long run)<br><small>Illustrative band, not a mapped shoreline.</small>`;
  pop('scenario-playa-fill', lakebed);
  pop('atlas-permits-circle', permitPopup, 'scenario-projects-circle');
  pop('atlas-basinrisk-circle', (p) => `<b>${esc(p.name)}</b> · risk score <b>${Math.round(p.score)}</b> (${esc(p.category)})<br>
    Counted demand ${fmt(p.demand)} AF/yr vs headroom ${fmt(p.headroom)} AF/yr<br>Data center demand counted: ${fmt(p.projects_af)} AF/yr${+p.unknown ? ` · ${p.unknown} project(s) with no figure` : ''}
    ${p.curtail === true || p.curtail === 'true' ? '<br><b>J</b>: demand exceeds headroom and most rights are junior; junior rights would likely be curtailed first.' : ''}
    <br><small>PLACEHOLDER baselines, not agency data.</small>`, 'atlas-permits-circle');
  pop('atlas-playa-fill', lakebed, 'scenario-playa-fill');
}
