// node --test tests/atlas-tour.test.cjs
// The guided tour must reach every environmentally important part of the app, and every stop must be runnable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { STOPS, sections, OPTIONAL } = require('../public/assets/atlas-tour.js');
const all = (type) => STOPS.flatMap((s) => s.actions.filter((a) => a.type === type));

// What the app actually has, read from its own sources.
const billIds = [...read('backend/atlas/bills.py').matchAll(/"id": "(\w+)", "label"/g)].map((m) => m[1]);
const mockBills = billIds.filter((id) => id.startsWith('mock_'));
const projectIds = [...read('backend/atlas/engine.py').matchAll(/^\s{4}Project\("(\w+)"/gm)].map((m) => m[1]);
const impactTabs = Object.keys(eval(`(${read('public/assets/atlas-panel.js').match(/const TABS = (\{[^}]+\})/)[1]})`));
const waterLayers = [...read('public/assets/map-atlas.js').matchAll(/\{ id: '(atlas-[\w-]+)'/g)].map((m) => m[1]);
const airLayers = [...read('public/assets/map-climate.js').matchAll(/hub\.addLayer\(\{ id: "(f-\w+)"/g)].map((m) => m[1]);
const rowTitles = [...read('public/assets/atlas-panel.js').matchAll(/this\.(?:row|flag)\('([^']+)'/g)].map((m) => m[1]);

test('stops are well formed and each one sets its whole scene', () => {
  assert.ok(STOPS.length >= 20, `only ${STOPS.length} stops`);
  assert.equal(new Set(STOPS.map((s) => s.id)).size, STOPS.length);
  for (const s of STOPS) {
    assert.ok(s.section && s.title && s.text.length > 80, s.id);
    assert.ok(!/—/.test(s.text), `${s.id}: em dash`);
    const types = s.actions.map((a) => a.type);
    for (const t of ['clear_levers', 'set_branch', 'select_projects', 'impact_tab', 'show_math', 'set_basin', 'open_tab', 'fly_to', 'focus', 'inversion_card']) {
      assert.ok(types.includes(t), `${s.id} does not set ${t}`);
    }
    const set = s.actions.filter((a) => a.type === 'set_layer').map((a) => a.id);
    for (const id of OPTIONAL) assert.ok(set.includes(id), `${s.id} leaves layer ${id} as the last stop had it`);
  }
  assert.equal(sections()[0].index, 0);
  assert.ok(sections().length >= 6);
});

test('every action refers to something that exists', () => {
  const runner = read('public/assets/atlas-extras.js');
  for (const s of STOPS) for (const a of s.actions) {
    assert.ok(runner.includes(`a.type === '${a.type}'`), `${s.id}: the runner has no ${a.type}`);
    if (a.type === 'apply_bill') assert.ok(billIds.includes(a.bill_id), `${s.id}: bill ${a.bill_id}`);
    if (a.type === 'select_projects') for (const id of a.ids) assert.ok(projectIds.includes(id), `${s.id}: project ${id}`);
    if (a.type === 'open_compare') assert.ok(projectIds.includes(a.project_id));
    if (a.type === 'impact_tab') assert.ok(impactTabs.includes(a.tab), `${s.id}: tab ${a.tab}`);
    if (a.type === 'open_tab') assert.ok(['today', 'layers', 'impact'].includes(a.tab));
    if (a.type === 'set_layer') assert.ok([...waterLayers, ...airLayers].includes(a.id), `${s.id}: layer ${a.id}`);
    if (a.type === 'fly_to') assert.ok(a.lat >= 36.9 && a.lat <= 42.1 && a.lng >= -114.1 && a.lng <= -109 && a.zoom >= 5, `${s.id}: off the Utah map`);
    if (a.type === 'focus' && a.row) assert.ok(rowTitles.includes(a.row), `${s.id}: no result row titled ${a.row}`);
    if (a.type === 'focus' && a.sel) assert.ok(read('public/assets/atlas-panel.js').includes(a.sel.replace(/^\./, '')), `${s.id}: ${a.sel}`);
  }
});

test('the tour covers every environmentally important part of the app', () => {
  // every Impact sub-tab and every main tab
  assert.deepEqual([...new Set(all('impact_tab').map((a) => a.tab))].sort(), [...impactTabs].sort());
  assert.deepEqual([...new Set(all('open_tab').map((a) => a.tab))].sort(), ['impact', 'layers', 'today']);
  // every water layer is switched on at some stop, plus the air-quality and mixing-height fields
  const shown = new Set(all('set_layer').filter((a) => a.on).map((a) => a.id));
  for (const id of [...waterLayers, 'f-pm', 'f-mix']) assert.ok(shown.has(id), `layer ${id} is never shown`);
  // every result row is either focused or named in a stop's text
  const focused = new Set(all('focus').map((a) => a.row).filter(Boolean));
  const text = STOPS.map((s) => s.text).join(' ').toLowerCase();
  for (const row of rowTitles) assert.ok(focused.has(row) || text.includes(row.toLowerCase()), `result row ${row} is never shown`);
  // every illustrative bill, at least two real measures, a county moratorium and the reporting law
  const applied = new Set(all('apply_bill').map((a) => a.bill_id));
  for (const id of mockBills) assert.ok(applied.has(id), `mock bill ${id} is never applied`);
  assert.ok(applied.has('hb76_2026') && applied.has('iron_2026_13'));
  // the branch strip, the dry-year control, show the math, the inversion card
  assert.equal(all('open_compare').length, 1);
  assert.ok(all('set_basin').some((a) => a.dry < 100));
  assert.ok(all('show_math').some((a) => a.on));
  assert.ok(all('inversion_card').some((a) => a.open));
  // every project is on the map at some stop, and each lake-basin and non-lake basin is visited
  const selected = new Set(all('select_projects').flatMap((a) => a.ids));
  for (const id of projectIds) assert.ok(selected.has(id), `project ${id} is never selected`);
});

test('take-away pages are linked and exist', () => {
  const links = STOPS.flatMap((s) => s.links || []).map((l) => l.href.split(/[?#]/)[0]);
  const rewrites = JSON.parse(read('vercel.json')).rewrites.map((r) => r.source);
  for (const href of ['/screen', '/briefing', '/inversion', '/about', '/atlas/pilots/stratos_who_pays.html']) assert.ok(links.includes(href), `no link to ${href}`);
  for (const href of links) assert.ok(rewrites.includes(href) || fs.existsSync(path.join(ROOT, 'public', href)), `${href} is not served`);
});

test('every stop runs through the map action runner and ends in the scene it describes', async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  const tabs = { today: { on: true }, layers: { on: false }, impact: { on: false } };
  for (const [name, t] of Object.entries(tabs)) {
    t.classList = { contains: () => t.on };
    t.click = () => { for (const o of Object.values(tabs)) o.on = false; t.on = true; t.name = name; };
  }
  const inv = { collapsed: false, classList: { toggle: (_, v) => (inv.collapsed = v) } };
  globalThis.document = {
    querySelector: (sel) => tabs[(sel.match(/data-tab="(\w+)"/) || [])[1]] || null,
    getElementById: (id) => (id === 'inv' ? inv : null),
  };
  const hub = { state: { layers: new Set(['atlas-projects']) }, flown: null,
    setLayer(id, on) { on ? this.state.layers.add(id) : this.state.layers.delete(id); },
    map: { flyTo: (o) => (hub.flown = o) } };
  const panel = {
    ready: Promise.resolve(), billsReady: Promise.resolve(), projects: projectIds.map((id) => ({ id })), strip: { open: false, close() { this.open = false; } },
    s: { tab: 'proposed', selected: new Set(['stratos']), branch: 'built', levers: {}, bills: [], math: false, basin: { dry: 100 } },
    applied: [], revealed: null,
    applyBill(id) { if (!billIds.includes(id)) return false; this.applied.push(id); if (this.s.branch === 'built') this.s.branch = 'conditions'; return true; },
    openCompare(pid) { this.strip.open = pid; return Promise.resolve(); },
    render() {}, renderBody() {}, compute() {}, setActive() {}, isActive: () => tabs.impact.on, updateBasins() {},
    reveal(target) { this.revealed = target; },
  };
  const { runAtlasActions } = await import(pathToFileURL(path.join(ROOT, 'public/assets/atlas-extras.js')).href);
  try {
    for (const s of STOPS) {
      panel.applied = [];
      await runAtlasActions(s.actions, { hub, getPanel: () => panel });
      const want = (type) => s.actions.filter((a) => a.type === type);
      assert.equal(panel.s.tab, want('impact_tab').at(-1).tab, s.id);
      assert.deepEqual([...panel.s.selected], want('select_projects').at(-1).ids, s.id);
      assert.deepEqual(panel.applied, want('apply_bill').map((a) => a.bill_id), s.id);
      assert.equal(panel.s.branch, panel.applied.length ? 'conditions' : 'built', s.id);
      assert.equal(panel.s.math, want('show_math').at(-1).on, s.id);
      assert.equal(panel.s.basin.dry, want('set_basin').at(-1).dry, s.id);
      assert.equal(!!panel.strip.open, want('open_compare').length > 0, `${s.id}: branch strip`);
      assert.equal(tabs[want('open_tab').at(-1).tab].on, true, `${s.id}: main tab`);
      assert.equal(inv.collapsed, !want('inversion_card').at(-1).open, s.id);
      for (const a of want('set_layer')) assert.equal(hub.state.layers.has(a.id), a.on, `${s.id}: layer ${a.id}`);
      assert.deepEqual(hub.flown.center, [want('fly_to').at(-1).lng, want('fly_to').at(-1).lat], s.id);
      assert.ok(panel.revealed && (panel.revealed.top || panel.revealed.row || panel.revealed.sel), s.id);
    }
  } finally { console.warn = realWarn; }
  assert.deepEqual(warnings, []);
});
