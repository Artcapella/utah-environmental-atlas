// node --test tests/atlas-basin-risk.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/atlas/data/basin_risk.json'), 'utf8'));
const load = () => import(pathToFileURL(path.join(ROOT, 'public/assets/atlas-basin-risk.js')).href);

test('engine lens: lower engine water (e.g. a closed-loop lever) lowers the basin score', async () => {
  const { scoreBasins } = await load();
  const score = (af) => scoreBasins(data, { lens: 'engine', engineAF: { stratos: af } }).find((r) => r.name === 'Bear River');
  const built = score(40000), conditioned = score(1200);
  assert.ok(built.score > conditioned.score);
  assert.equal(built.projects_af, 40000);
});

test('engine lens counts only projects in the current scenario', async () => {
  const { scoreBasins } = await load();
  const none = scoreBasins(data, { lens: 'engine', engineAF: {} });
  assert.ok(none.every((r) => r.projects_af === 0));
});

test('dry year shrinks headroom and can raise the junior-curtailment flag', async () => {
  const { scoreBasins } = await load();
  const wet = scoreBasins(data, { lens: 'rights', dry: 100 }), dry = scoreBasins(data, { lens: 'rights', dry: 40 });
  wet.forEach((r, i) => assert.ok(dry[i].score >= r.score));
  assert.ok(dry.filter((r) => r.curtail).length >= wet.filter((r) => r.curtail).length);
});

test('year filter and paused projects', async () => {
  const { scoreBasins } = await load();
  const early = scoreBasins(data, { lens: 'rights', year: 2026 }).find((r) => r.name === 'Bear River');
  const late = scoreBasins(data, { lens: 'rights', year: 2032 }).find((r) => r.name === 'Bear River');
  assert.equal(early.projects_af, 0);          // Stratos assumed online 2028
  assert.equal(late.projects_af, 13000);       // its 13,000 AF of rights
});

test('GeoJSON output is flagged as placeholder', async () => {
  const { scoreBasins, basinRiskGeoJSON } = await load();
  const fc = basinRiskGeoJSON(scoreBasins(data, { lens: 'high' }));
  assert.equal(fc.features.length, data.basins.length);
  assert.ok(fc.features.every((f) => f.properties.placeholder === true));
});
