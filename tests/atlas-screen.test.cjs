// node --test tests/atlas-screen.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const load = () => import(pathToFileURL(path.join(ROOT, 'public/assets/atlas-screen.js')).href);

// Shapes of GET /api/atlas/projects rows (backend/atlas/engine.py REGISTRY).
const stratos = { id: 'stratos', name: 'Stratos / Wonder Valley', county: 'Box Elder', lat: 41.7, lon: -112.55, mw: 9000,
  cooling: null, onsite_gas: true, power_cooling: null, gsl_basin: true, water_source: 'basin', stated_af: 1215, rights_af: 13000, basin: 'Bear River / GSL' };
const nineMile = { id: 'nine_mile', name: 'Nine Mile (Energence)', county: 'Duchesne', lat: 39.9, lon: -110.4, mw: 400,
  cooling: null, onsite_gas: null, power_cooling: null, gsl_basin: false, water_source: 'produced_water', stated_af: null, rights_af: null, basin: 'Uinta (Colorado River)' };

test('a registry project keeps what is unknown as unknown', async () => {
  const { fromAtlas } = await load();
  const s = fromAtlas(stratos);
  assert.deepEqual([s.mw, s.cooling, s.power, s.source, s.basin, s.request], [9000, 'usavg', 'gasTurbine', 'newright', 'gsl', 1215]);
  assert.deepEqual([s.util, s.pue], [80, 1.3]);   // the engine's central load factor and PUE
  const n = fromAtlas(nineMile);
  assert.deepEqual([n.cooling, n.power, n.source, n.basin, n.request], ['usavg', 'grid', 'reclaimed', 'colorado', null]);
  assert.equal(fromAtlas({ ...nineMile, water_source: 'basin' }).source, 'unknown');
});

test('the estimate matches the documented formula and keeps low <= central <= high', async () => {
  const { estimate, GAL_PER_AF } = await load();
  const p = { mw: 300, basis: 'facility', util: 80, pue: 1.3, cooling: 'evap', power: 'grid' };
  const { lo, mid, hi } = estimate(p);
  const fac = 300 * 8760 * 0.8;
  assert.ok(Math.abs(mid.direct - ((fac / 1.3) * 1000 * 1.8) / 3.785 / GAL_PER_AF) < 1e-6);
  assert.ok(Math.abs(mid.indirect - (fac * 1160) / GAL_PER_AF) < 1e-6);
  for (const k of ['direct', 'indirect']) assert.ok(lo[k] <= mid[k] && mid[k] <= hi[k]);
  // MW given as server load: facility energy is larger by the PUE
  assert.ok(Math.abs(estimate({ ...p, basis: 'it' }).mid.fac - fac * 1.3) < 1e-6);
});

test('map links: registry projects go by id, dropped projects carry their fields', async () => {
  const { screenUrl, fromParams } = await load();
  assert.equal(screenUrl(stratos), '/screen?project=stratos');
  assert.equal(screenUrl(stratos, { mw: 9000 }), '/screen?project=stratos');
  assert.equal(screenUrl(stratos, { mw: 3000 }), '/screen?project=stratos&mw=3000');
  const url = screenUrl({ name: 'Dropped 300 MW', mw: 300, cooling: 'closed_loop', onsite_gas: true, gsl_basin: true });
  const { p, atlas } = fromParams(new URL(url, 'http://x').searchParams, [stratos]);
  assert.equal(atlas, null);
  assert.deepEqual([p.name, p.mw, p.cooling, p.power, p.basin, p.source], ['Dropped 300 MW', 300, 'dry', 'gasTurbine', 'gsl', 'unknown']);
});

test('the URL round-trips the form and ignores bad values', async () => {
  const { fromAtlas, fromParams, toParams } = await load();
  const edited = { ...fromAtlas(stratos), mw: 3000, cooling: 'hybrid', request: null, reporting: true };
  const q = toParams(edited, stratos);
  assert.equal(q.get('project'), 'stratos');
  assert.equal(q.has('power'), false);   // unchanged from the registry: not in the link
  assert.deepEqual(fromParams(q, [stratos]).p, edited);
  const bad = fromParams(new URLSearchParams('project=nope&mw=-5&cooling=constructor&util=77&pue=9'), [stratos]);
  assert.equal(bad.atlas, null);
  assert.deepEqual([bad.p.mw, bad.p.cooling, bad.p.util, bad.p.pue], [300, 'usavg', 65, 1.3]);
});

test('engine hand-off: untouched registry choices keep the registry fields, edited ones are mapped', async () => {
  const { fromAtlas, toEngine } = await load();
  const same = toEngine(fromAtlas(stratos), stratos);
  assert.deepEqual([same.mw, same.cooling, same.onsite_gas, same.power_cooling, same.gsl_basin], [9000, null, true, null, true]);
  const edited = toEngine({ ...fromAtlas(stratos), cooling: 'evap', power: 'grid', basin: 'other' }, stratos);
  assert.deepEqual([edited.cooling, edited.onsite_gas, edited.power_cooling, edited.gsl_basin], ['evaporative', false, null, false]);
  const typed = toEngine({ name: '', mw: 100, basis: 'it', pue: 1.3, cooling: 'hybrid', power: 'gasRecip', basin: 'gsl' });
  assert.deepEqual([typed.mw, typed.cooling, typed.onsite_gas, typed.power_cooling], [130, null, true, 'dry']);
  assert.ok(typed.lat >= 36.5 && typed.lat <= 42.5 && typed.lon >= -114.5 && typed.lon <= -108.5);   // CustomProject bounds
});
