// Utah Environmental Atlas — MapLibre overlay layers.
// Drop-in for the existing YOUtah /map (MapLibre GL JS v3+/v4+). No build step needed.
//
//   import { addAtlasLayers, setGroupVisibility, updateScenarioOverlays, LEGENDS } from './atlas/layers.js';
//   map.on('load', () => addAtlasLayers(map, { base: '/static/atlas', firmsKey: null }));
//
// Static files come from static/atlas/ (built by scripts/build_static_layers.py; live-source
// files by scripts/fetch_layers.py). Missing files are skipped silently, so the map works
// before every fetch has run. Tile overlays load straight from the providers' servers.

export const ATLAS_BASE = '/static/atlas';

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
};

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
  projects: { title: 'Proposed data centers', items: [['Drains to Great Salt Lake', C.water], ['Other basin', '#8a6d3b']],
    note: 'Circle area = engine central water estimate. Locations are approximate.' },
};

// ---------------------------------------------------------------- helpers
async function exists(url) {
  try { const r = await fetch(url, { method: 'HEAD' }); return r.ok; } catch { return false; }
}
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
                                            visible = ['reference', 'lake', 'projects'] } = {}) {
  const f = (name) => `${base}/${name}`;

  // Reference + engine layers (always shipped)
  addGeo(map, 'atlas-boundary', f('utah_boundary.geojson'));
  addGeo(map, 'atlas-counties', f('utah_counties.geojson'));
  addGeo(map, 'atlas-gsl', f('gsl_reference.geojson'));
  addGeo(map, 'atlas-playa', f('gsl_playa_scenarios.geojson'));
  addGeo(map, 'atlas-projects', f('projects.geojson'));
  addGeo(map, 'scenario-projects', EMPTY);
  addGeo(map, 'scenario-playa', EMPTY);

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
      layout: { 'text-field': ['get', 'name'], 'text-size': 11 }, paint: { 'text-color': C.water, 'text-halo-color': '#fff', 'text-halo-width': 1 } }, beforeId);
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
    layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-optional': true },
    paint: { 'text-color': C.ink, 'text-halo-color': '#fff', 'text-halo-width': 1.2 } }, beforeId);

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
function bindPopups(map) {
  if (map.__atlasPopups || !window.maplibregl) return;
  map.__atlasPopups = true;
  const pop = (layer, html) => {
    map.on('click', layer, (e) => new window.maplibregl.Popup({ maxWidth: '300px' })
      .setLngLat(e.lngLat).setHTML(html(e.features[0].properties)).addTo(map));
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  };
  pop('atlas-projects-circle', (p) => `<b>${p.name}</b><br>${p.county} County · ${p.basin}<br>${fmt(p.mw)} MW · ${p.status}<hr style="margin:4px 0">
    Engine water: <b>${fmt(p.water_central)}</b> AF/yr (range ${fmt(p.water_low)}–${fmt(p.water_high)})<br>
    Developer stated: ${fmt(p.stated_af)} · Rights: ${fmt(p.rights_af)} · Highest on record: ${fmt(p.published_high_af)}<br>
    <small>Location approximate. Engine values are estimates.</small>`);
  pop('atlas-counties-fill', (p) => `<b>${p.name} County</b><br>${p.projects} proposed project(s)<br>Engine water: ${fmt(p.water_central_af)} AF/yr<br>Stated: ${fmt(p.stated_af)} AF/yr`);
  pop('atlas-playa-fill', (p) => `<b>Extra exposed lakebed</b><br>${p.branch}: ~${fmt(p.playa_acres_central)} acres, lake ~${p.level_drop_ft_central} ft lower (long run)<br><small>Illustrative band, not a mapped shoreline.</small>`);
}
