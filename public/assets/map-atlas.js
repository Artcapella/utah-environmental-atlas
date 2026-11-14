/* Environmental Atlas plug-in for the map (public/map.html). ES module; loads after the map core.
 *
 *  - Registers the atlas overlays as layers in Layers › "Data centers & water" (window.YOUtah.addLayer).
 *  - Mounts the Impact Panel in the "Impact" tab: proposed data centers, legislation levers and the
 *    with-bill vs. without-bill comparison, basin water risk, permit pipeline, drop-a-project.
 *  - Re-adds its sources after any basemap style reload (map.setStyle drops them).
 *
 * Data: /api/atlas/* (backend/atlas/router.py) and /atlas/data/* (static layers).
 */
import { addAtlasLayers, setGroupVisibility, setTileOverlay, LEGENDS } from './atlas-layers.js';
import { ImpactPanel } from './atlas-panel.js';
import { runAtlasActions } from './atlas-extras.js';

const hub = window.YOUtah;
const UTAH_BOUNDS = [[-114.05, 37.0], [-109.05, 42.0]];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// hub layer id -> what it toggles. Ordered as they appear in the Layers tab.
const LAYERS = [
  { id: 'atlas-projects', group: 'projects', on: true, emoji: '🏭', color: '#2b6f9e', src: 'atlas', name: 'Proposed data centers (engine water estimate)' },
  { id: 'atlas-permits', group: 'permits', emoji: '📋', color: '#d2622f', src: 'permits', name: 'Data center permit pipeline (land, water, air)' },
  { id: 'atlas-lake', group: 'lake', on: true, emoji: '🌊', color: '#3d8fc4', src: 'atlasgsl', name: 'Great Salt Lake and extra exposed lakebed' },
  { id: 'atlas-basinrisk', group: 'basinrisk', emoji: '💧', color: '#e2a43a', src: 'basinrisk', name: 'Basin water risk (placeholder baselines)' },
  { id: 'atlas-water', group: 'water', emoji: '🚰', color: '#4a8bb8', src: 'atlas', name: 'Computed data center water use by county' },
  { id: 'atlas-reference', group: 'reference', emoji: '🗺', color: '#566b74', src: 'census', name: 'County lines' },
  { id: 'atlas-wbd-tiles', tile: true, emoji: '〰', color: '#2b6f9e', src: 'wbd', name: 'Watershed boundaries (USGS WBD)' },
  { id: 'atlas-fema-tiles', tile: true, emoji: '🌧', color: '#6fa8bf', src: 'fema', name: 'Flood zones (FEMA NFHL)' },
];

function legendHtml(group) {
  const L = LEGENDS[group];
  if (!L) return '';
  const rows = L.items || (L.stops || []).map(([v, c]) => [`${Number(v).toLocaleString()}+ AF/yr`, c]);
  return `<div class="fine"><b>${esc(L.title)}</b>${rows.map(([label, c]) => `<div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${c};margin-right:6px"></span>${esc(label)}</div>`).join('')}${L.note ? `<div>${esc(L.note)}</div>` : ''}</div>`;
}

function boot() {
  const map = hub.map;
  let pending = null, panel = null, firstOpen = true;
  const isOn = (id) => hub.state.layers.has(id);
  const visibleGroups = () => LAYERS.filter((l) => l.group && isOn(l.id)).map((l) => l.group);

  // Sources vanish on map.setStyle; re-add on demand (addAtlasLayers is idempotent).
  function ensure() {
    if (!hub.mapReady) return Promise.resolve(false);
    if (map.getLayer('atlas-projects-circle')) return Promise.resolve(true);
    if (!pending) pending = addAtlasLayers(map, { visible: visibleGroups() }).then(() => true, (e) => { console.warn('Atlas layers failed:', e); return false; })
      .finally(() => { pending = null; });
    return pending;
  }
  function sync() {
    for (const l of LAYERS) l.tile ? setTileOverlay(map, l.id, isOn(l.id)) : setGroupVisibility(map, l.group, isOn(l.id));
  }

  function ensurePanel() {
    if (panel) return panel;
    const slot = document.getElementById('tab-impact');
    // Map-first: the scenario's headline numbers sit on the map, not only in the side panel.
    const mapCard = Object.assign(document.createElement('section'), { id: 'atlasMapCard', className: 'glass', hidden: true });
    mapCard.setAttribute('aria-live', 'polite');
    mapCard.setAttribute('aria-label', 'Scenario findings');
    document.body.append(mapCard);
    panel = new ImpactPanel(slot, { map, api: '/api/atlas', data: '/atlas/data', briefingUrl: '/briefing', mapCard,
                                    isActive: () => slot.classList.contains('on') });
    return panel;
  }

  for (const [key, val] of Object.entries({
    atlas: { name: 'Atlas impact engine (sourced factor model)', url: '/atlas/briefing.html' },
    atlasgsl: { name: 'Natural Earth outline + engine lakebed band' },
    permits: { name: 'Permit pipeline: news, county and agency records' },
    basinrisk: { name: 'Water planner model, placeholder baselines' },
    census: { name: 'US Census county boundaries' },
    wbd: { name: 'USGS Watershed Boundary Dataset', url: 'https://www.usgs.gov/national-hydrography/watershed-boundary-dataset' },
    fema: { name: 'FEMA National Flood Hazard Layer', url: 'https://www.fema.gov/flood-maps/national-flood-hazard-layer' },
  })) hub.SOURCES[key] = hub.SOURCES[key] || val;

  let prev = null;
  for (const l of LAYERS) {
    hub.addLayer({
      id: l.id, cat: 'atlas', name: l.name, emoji: l.emoji, color: l.color, src: l.src, on: !!l.on, after: prev || undefined,
      legend: () => (l.group ? legendHtml(l.group) : ''),
      apply: (on) => {
        if (on && l.id === 'atlas-basinrisk') ensurePanel();   // the panel computes the basin scores
        ensure().then((ok) => ok && sync());
      },
    });
    prev = l.id;
  }

  // Impact tab: mount the panel on first open, frame the whole state, keep drop-mode in step with visibility.
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    const opening = b.dataset.tab === 'impact';
    if (opening) {
      ensurePanel();
      if (firstOpen) {
        firstOpen = false;
        // Big ring = engine water estimate; small dot = permit stage. Both read straight off the map.
        for (const id of ['atlas-projects', 'atlas-lake', 'atlas-permits']) if (!isOn(id)) hub.setLayer(id, true);
        // Water view: clear the air-quality field and wind arrows (still in Layers) and fold the inversion card.
        for (const id of ['f-pm', 'f-temp', 'f-mix', 'f-wind', 'f-anom']) if (isOn(id)) hub.setLayer(id, false);
        document.getElementById('inv')?.classList.add('collapsed');
        // Frame the state below the headline card so it never covers the Great Salt Lake.
        const top = window.matchMedia('(max-width: 899px)').matches ? 40 : 230;
        if (hub.mapReady) map.fitBounds(UTAH_BOUNDS, { padding: { top, bottom: 80, left: 30, right: 90 }, pitch: 0, duration: 900 });
      }
    }
    document.body.classList.toggle('atlas-impact', opening);   // hides the climate card under the map headline
    panel?.setActive(opening);
  });

  // The assistant (map-guide.js) moves the map through this: run(actions) and state() for what is on screen.
  window.YOUtahAtlas = {
    run: (actions) => runAtlasActions(actions, { hub, getPanel: ensurePanel }),
    state: () => (panel?.projects ? panel.appState() : null),
  };

  // Deep link: /?impact opens the Impact tab directly (used by the briefing's "back to map" link).
  if (new URLSearchParams(location.search).has('impact')) document.querySelector('#tabs [data-tab="impact"]')?.click();
}

(function wait() {
  if (!hub) return;
  if (hub.map) boot(); else setTimeout(wait, 100);
})();
