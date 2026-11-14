// Environmental Atlas — Impact Panel (vanilla ES module). Talks to /api/atlas/* (backend/atlas/router.py).
// Mounted in the map's "Impact" tab by /assets/map-atlas.js.
//
// Design rules (docs/atlas/design.md): ranges always · developer/agency says vs engine estimate vs
// highest on record side by side · every published figure carries a source-type tag with a distinct
// outline (not color-only) · "not quantified" shown, never zero · no net score · "would", not "will".
import { updateScenarioOverlays, setPlayaScenario } from './atlas-layers.js';

const TAGS = { gov: 'Government', dev: 'Developer', ind: 'Independent academic', adv: 'Advocacy-commissioned', der: 'Derived' };
const BRANCHES = { built: 'Built as planned', conditions: 'Built with conditions', scaled: 'Delayed or scaled down', not_built: 'Not built here' };
const LEVER_LABELS = {
  cooling_required: 'Closed-loop cooling required', power_cooling_required: 'Dry-cooled power plants required',
  onsite_gas_allowed: 'On-site gas allowed', max_wue: 'Max WUE (L/kWh)', gsl_offset_ratio: 'GSL offset (AF delivered per AF used)',
  moratorium_counties: 'County moratoria', habitat_setback_km: 'Habitat setback (km)', reporting_threshold_af: 'Reporting threshold (AF/yr)',
};
const TABS = { proposed: 'Proposed', drop: 'Drop a project', legislation: 'Legislation', context: 'Who decides' };
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const rng = (r) => `${fmt(r[1])} <span class="ip-muted">(${fmt(r[0])}–${fmt(r[2])})</span>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tag = (k) => `<span class="ip-tag ${esc(k)}" title="Source type">${esc(TAGS[k] || k)}</span>`;

// Ray-casting point-in-polygon for the county lookup of dropped projects (GeoJSON Polygon/MultiPolygon).
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inGeom(x, y, g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some((p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h)));
}

export class ImpactPanel {
  constructor(el, { map = null, api = '/api/atlas', data = '/atlas/data', briefingUrl = '/briefing', isActive = () => true } = {}) {
    Object.assign(this, { el, map, api, data, briefingUrl, isActive });
    this.s = {
      tab: 'proposed', selected: new Set(['stratos']), branch: 'built', scale: 0.5, sizes: {},
      levers: {}, custom: [], math: false, result: null, summary: null, bill: null, proposal: null, busy: false,
      drop: { name: '', mw: 300, cooling: 'evaporative', onsite_gas: false, gsl_basin: true },
    };
    el.classList.add('ip');
    this.ready = this.init();
  }

  async init() {
    this.el.innerHTML = '<p class="ip-muted">Loading the project registry…</p>';
    try {
      const [projects, context] = await Promise.all([
        fetch(`${this.api}/projects`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
        fetch(`${this.data}/context.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      this.projects = projects;
      this.context = context;
    } catch (e) {
      this.el.innerHTML = `<p class="ip-err">The impact engine is unavailable (${esc(e.message)}). The map layers still show the precomputed "all built as planned" scenario.</p>`;
      return;
    }
    fetch(`${this.data}/utah_counties.geojson`).then((r) => r.json()).then((fc) => (this.counties = fc.features)).catch(() => {});
    if (this.map) this.map.on('click', (e) => this.onMapClick(e));
    this.render();
    this.compute();
  }

  /** Called by map-atlas.js when the Impact tab is shown or hidden. */
  setActive(on) {
    if (!this.map) return;
    this.map.__atlasDropMode = on && this.s.tab === 'drop';
    this.map.getCanvas().style.cursor = this.map.__atlasDropMode ? 'crosshair' : '';
  }

  // ------------------------------------------------------------ data
  body(extra = {}) {
    const s = this.s;
    return { project_ids: [...s.selected], custom: s.custom, levers: s.branch === 'built' ? {} : s.levers,
             branch: s.branch, scale: s.scale, sizes: s.sizes, ...extra };
  }
  async post(path, body) {
    const r = await fetch(`${this.api}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j); } catch {}
      throw new Error(msg);
    }
    return r.json();
  }
  compute() {
    clearTimeout(this._t);
    this._t = setTimeout(async () => {
      const seq = (this._seq = (this._seq || 0) + 1);
      try {
        const [result, overlays] = await Promise.all([this.post('/impact', this.body()), this.post('/overlays', this.body())]);
        if (seq !== this._seq) return;   // a newer request superseded this one
        this.s.result = result;
        this.s.summary = null;
        if (this.map) { updateScenarioOverlays(this.map, overlays); setPlayaScenario(this.map, '__none__'); }
      } catch (e) {
        if (seq === this._seq) this.s.result = { error: String(e.message || e) };
      }
      this.renderBody();
    }, 150);
  }
  async explain() {
    const box = this.el.querySelector('.ip-summary');
    box.innerHTML = '<p class="ip-muted">Writing a plain-language summary from the engine numbers…</p>';
    try { this.s.summary = (await this.post('/impact', this.body({ explain: true }))).summary; }
    catch (e) { this.s.summary = { summary: null, error: String(e.message || e) }; }
    this.renderBody();
  }
  async parseBill(text) {
    this.s.bill = { loading: true }; this.renderTab();
    try { this.s.bill = await this.post('/extract/bill', { text }); }
    catch (e) { this.s.bill = { error: String(e.message || e) }; }
    this.renderTab();
  }
  async parseProposal(text) {
    this.s.proposal = { loading: true }; this.renderTab();
    try {
      const x = await this.post('/extract/project', { text });
      const d = this.s.drop;
      if (x.name) d.name = x.name;
      if (x.mw) d.mw = x.mw;
      if (x.cooling) d.cooling = x.cooling;
      if (x.onsite_gas != null) d.onsite_gas = x.onsite_gas;
      d.power_cooling = x.power_cooling || undefined;
      d.footprint_acres = x.footprint_acres || undefined;
      this.s.proposal = x;
    } catch (e) { this.s.proposal = { error: String(e.message || e) }; }
    this.renderTab();
  }
  countyAt(lng, lat) {
    const f = (this.counties || []).find((c) => c.geometry && inGeom(lng, lat, c.geometry));
    return f ? f.properties.name : null;
  }
  onMapClick(e) {
    if (this.s.tab !== 'drop' || !this.isActive() || window.YOUtah?.state?.pickMode) return;
    const d = this.s.drop, county = this.countyAt(e.lngLat.lng, e.lngLat.lat);
    if (!county) { this.flash('Drop the project inside Utah.'); return; }
    if (!(+d.mw > 0)) { this.flash('Set a size in MW first.'); return; }
    this.s.custom.push({ name: d.name || `Dropped ${fmt(d.mw)} MW`, county, lat: e.lngLat.lat, lon: e.lngLat.lng, mw: +d.mw,
                         cooling: d.cooling, onsite_gas: d.onsite_gas, gsl_basin: d.gsl_basin,
                         ...(d.power_cooling ? { power_cooling: d.power_cooling } : {}),
                         ...(d.footprint_acres ? { footprint_acres: d.footprint_acres } : {}) });
    this.renderTab(); this.compute();
  }
  flash(msg) {
    const n = this.el.querySelector('.ip-flash');
    if (!n) return;
    n.textContent = msg; n.hidden = false;
    clearTimeout(this._ft); this._ft = setTimeout(() => (n.hidden = true), 3500);
  }

  // ------------------------------------------------------------ shell
  render() {
    const s = this.s;
    this.el.innerHTML = `
      <p class="ip-lede">Estimated water, Great Salt Lake and air effects of proposed Utah data centers. Ranges from a sourced factor model; nothing here is a measurement.</p>
      <div class="ip-tabs" role="tablist">
        ${Object.entries(TABS).map(([k, v]) => `<button role="tab" data-tab="${k}" aria-selected="${s.tab === k}">${v}</button>`).join('')}
      </div>
      <div class="ip-tabbody"></div>
      <div class="ip-flash" role="status" hidden></div>
      <div class="ip-branch" role="group" aria-label="Scenario branch">
        ${Object.entries(BRANCHES).map(([k, v]) => `<button data-branch="${k}" aria-pressed="${s.branch === k}">${v}</button>`).join('')}
      </div>
      ${s.branch === 'scaled' ? `<label class="ip-scale">Share of announced size
        <select data-scale>${[0.25, 0.5, 0.75].map((x) => `<option value="${x}" ${s.scale == x ? 'selected' : ''}>${x * 100}%</option>`).join('')}</select></label>` : ''}
      ${s.branch === 'conditions' && !Object.keys(s.levers).length ? '<p class="ip-muted ip-hint">No conditions set yet. Choose levers in the <b>Legislation</b> tab.</p>' : ''}
      <div class="ip-summary" aria-live="polite"></div>
      <div class="ip-body" aria-live="polite"></div>
      <div class="ip-foot">
        <label><input type="checkbox" class="ip-math" ${s.math ? 'checked' : ''}> Show the math</label>
        <button class="ip-explain">Plain-language summary</button>
        <button class="ip-copy">Copy citation</button>
        <button class="ip-dl">Download citation</button>
        <a class="ip-brief" href="${this.briefingUrl}?branch=${s.branch}" target="_blank" rel="noopener">Legislative briefing ↗</a>
        <a href="/atlas/pilots/stratos_who_pays.html" target="_blank" rel="noopener">Stratos: who pays ↗</a>
      </div>`;
    this.el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => {
      s.tab = b.dataset.tab; this.render(); this.renderBody(); this.setActive(this.isActive());
    }));
    this.el.querySelectorAll('[data-branch]').forEach((b) => (b.onclick = () => { s.branch = b.dataset.branch; this.render(); this.compute(); }));
    this.el.querySelector('[data-scale]')?.addEventListener('change', (e) => { s.scale = +e.target.value; this.compute(); });
    this.el.querySelector('.ip-math').onchange = (e) => { s.math = e.target.checked; this.renderBody(); };
    this.el.querySelector('.ip-explain').onclick = () => this.explain();
    this.el.querySelector('.ip-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(this.citation()); this.flash('Citation copied.'); }
      catch { this.flash('Copy failed; use Download citation instead.'); }
    };
    this.el.querySelector('.ip-dl').onclick = () => this.download();
    this.renderTab();
    if (s.result) this.renderBody();
  }

  renderTab() {
    const s = this.s, box = this.el.querySelector('.ip-tabbody');
    if (!box) return;
    const html = { proposed: () => this.tabProposed(), drop: () => this.tabDrop(), legislation: () => this.tabLegislation(), context: () => this.tabContext() }[s.tab]();
    box.innerHTML = html;
    const on = (sel, ev, fn) => box.querySelectorAll(sel).forEach((n) => n.addEventListener(ev, fn));
    on('[data-pid]', 'change', (e) => { const c = e.target; c.checked ? s.selected.add(c.dataset.pid) : s.selected.delete(c.dataset.pid); this.compute(); });
    on('[data-size]', 'change', (e) => { const c = e.target; c.value ? (s.sizes[c.dataset.size] = +c.value) : delete s.sizes[c.dataset.size]; this.compute(); });
    on('[data-all]', 'click', () => { this.projects.forEach((p) => s.selected.add(p.id)); this.renderTab(); this.compute(); });
    on('[data-none]', 'click', () => { s.selected.clear(); this.renderTab(); this.compute(); });
    on('[data-d]', 'change', (e) => { const c = e.target; s.drop[c.dataset.d] = c.type === 'checkbox' ? c.checked : c.type === 'number' ? +c.value : c.value; });
    on('[data-rm]', 'click', (e) => { s.custom.splice(+e.currentTarget.dataset.rm, 1); this.renderTab(); this.compute(); });
    on('.ip-parse-proposal', 'click', () => this.parseProposal(box.querySelector('.ip-proposaltext').value));
    on('.ip-parse', 'click', () => this.parseBill(box.querySelector('.ip-billtext').value));
    on('[data-lv]', 'change', (e) => {
      const l = s.bill.levers[+e.target.dataset.lv];
      if (!(l.lever in s.bill.levers_dict)) return;
      this.setLever(l.lever, e.target.checked ? s.bill.levers_dict[l.lever] : undefined);
    });
    on('[data-ml]', 'change', (e) => {
      const c = e.target, k = c.dataset.ml;
      let v;
      if (c.type === 'checkbox') v = c.checked ? JSON.parse(c.dataset.v) : undefined;
      else if (k === 'moratorium_counties') v = c.value.split(',').map((x) => x.trim()).filter(Boolean);
      else v = c.value === '' ? undefined : +c.value;
      if (Array.isArray(v) && !v.length) v = undefined;
      this.setLever(k, v);
    });
    on('[data-clear-levers]', 'click', () => { s.levers = {}; this.render(); this.compute(); });
  }

  setLever(k, v) {
    const s = this.s;
    if (v === undefined) delete s.levers[k]; else s.levers[k] = v;
    const branchChanged = Object.keys(s.levers).length && s.branch === 'built';
    if (branchChanged) s.branch = 'conditions';
    branchChanged ? this.render() : this.renderTab();
    this.compute();
  }

  tabProposed() {
    const s = this.s;
    return `<div class="ip-list">${this.projects.map((p) => `
      <div class="ip-proj"><label><input type="checkbox" data-pid="${esc(p.id)}" ${s.selected.has(p.id) ? 'checked' : ''}>
        <span>${esc(p.name)} <span class="ip-muted">${esc(p.county)} · ${fmt(p.mw)} MW · ${esc(p.status)}</span></span></label>
      ${Object.keys(p.size_options_mw || {}).length ? `<select data-size="${esc(p.id)}" class="ip-size" aria-label="Size for ${esc(p.name)}"><option value="">Size: as announced (${fmt(p.mw)} MW)</option>
        ${Object.entries(p.size_options_mw).map(([k, v]) => `<option value="${v}" ${s.sizes[p.id] == v ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>` : ''}</div>`).join('')}</div>
      <div class="ip-row-btns"><button data-all>All</button><button data-none>None</button><span class="ip-muted">Locations are approximate.</span></div>`;
  }

  tabDrop() {
    const s = this.s, d = s.drop, x = s.proposal;
    const quotes = x?.quotes?.length ? `<ul class="ip-quotes">${x.quotes.map((q) => `<li><b>${esc(q.field)}</b>: <q>${esc(q.quote)}</q></li>`).join('')}</ul>` : '';
    return `<p class="ip-muted">Set the project, then <b>click the map</b> to place it. The county is detected from the click.</p>
      <div class="ip-form">
        <label>Name<input type="text" data-d="name" value="${esc(d.name)}" placeholder="Dropped project" maxlength="80"></label>
        <label>Size (MW)<input type="number" min="1" max="50000" data-d="mw" value="${esc(d.mw)}"></label>
        <label>Cooling<select data-d="cooling"><option value="evaporative" ${d.cooling === 'evaporative' ? 'selected' : ''}>Evaporative</option><option value="closed_loop" ${d.cooling === 'closed_loop' ? 'selected' : ''}>Closed-loop</option></select></label>
        <label class="ip-check"><input type="checkbox" data-d="onsite_gas" ${d.onsite_gas ? 'checked' : ''}> On-site gas power</label>
        <label class="ip-check"><input type="checkbox" data-d="gsl_basin" ${d.gsl_basin ? 'checked' : ''}> Drains to Great Salt Lake</label>
      </div>
      ${s.custom.map((c, i) => `<div class="ip-chip">${esc(c.name)} · ${esc(c.county)} · ${fmt(c.mw)} MW <button data-rm="${i}" aria-label="Remove ${esc(c.name)}">×</button></div>`).join('')}
      <details class="ip-sub"><summary>Fill from proposal text</summary>
        <textarea class="ip-proposaltext" rows="4" placeholder="Paste a proposal, filing or news summary"></textarea>
        <button class="ip-parse-proposal">Read proposal</button>
        <p class="ip-muted">Gemini only copies stated facts, each with its quote. It never estimates.</p>
        ${x?.loading ? '<p class="ip-muted">Reading…</p>' : ''}${x?.error ? `<p class="ip-err">${esc(x.error)}</p>` : ''}
        ${x && !x.loading && !x.error ? `<p>Filled the form from the text${x.stated_af != null ? `; developer states ${fmt(x.stated_af)} AF/yr ${tag('dev')}` : ''}${x.rights_af != null ? `; rights ${fmt(x.rights_af)} AF` : ''}.</p>${quotes}` : ''}
      </details>`;
  }

  tabLegislation() {
    const s = this.s, b = s.bill, L = s.levers;
    const chk = (k, v, label) => `<label class="ip-check"><input type="checkbox" data-ml="${k}" data-v='${JSON.stringify(v)}' ${JSON.stringify(L[k]) === JSON.stringify(v) ? 'checked' : ''}> ${label}</label>`;
    const num = (k, label, step) => `<label>${label}<input type="number" min="0" step="${step}" data-ml="${k}" value="${L[k] ?? ''}"></label>`;
    return `<p class="ip-muted">Levers apply under <b>Built with conditions</b> or <b>Delayed or scaled down</b>. Setting one switches from Built as planned.</p>
      <div class="ip-form">
        ${chk('cooling_required', 'closed_loop', 'Require closed-loop cooling')}
        ${chk('power_cooling_required', 'dry', 'Require dry-cooled power plants')}
        ${chk('onsite_gas_allowed', false, 'Prohibit on-site gas (impacts move to the grid, not modeled)')}
        ${num('max_wue', 'Max WUE, L/kWh', 0.05)}
        ${num('gsl_offset_ratio', 'GSL offset, AF delivered per AF used', 0.1)}
        ${num('reporting_threshold_af', 'Reporting threshold, AF/yr (changes what the state knows, not use)', 1)}
        <label>County moratoria (comma-separated)<input type="text" data-ml="moratorium_counties" value="${esc((L.moratorium_counties || []).join(', '))}" placeholder="e.g. Iron, Millard"></label>
        <p class="ip-muted">County moratoria are capped at 180 days, and MIDA, not Box Elder County, holds jurisdiction at Stratos.</p>
      </div>
      ${Object.keys(L).length ? '<button data-clear-levers>Clear all levers</button>' : ''}
      <details class="ip-sub" ${b ? 'open' : ''}><summary>Read a bill</summary>
        <textarea class="ip-billtext" rows="5" placeholder="Paste bill text or a summary of its provisions"></textarea>
        <button class="ip-parse">Read bill</button>
        ${b?.loading ? '<p class="ip-muted">Reading…</p>' : ''}${b?.error ? `<p class="ip-err">${esc(b.error)}</p>` : ''}
        ${b?.levers ? `${b.bill_id || b.title ? `<p><b>${esc(b.bill_id || '')}</b> ${esc(b.title || '')}</p>` : ''}
          <p class="ip-muted">Confirm each lever before it applies.</p>
          ${b.levers.length ? b.levers.map((l, i) => `<label class="ip-lever"><input type="checkbox" data-lv="${i}" ${l.lever in L ? 'checked' : ''} ${l.lever in b.levers_dict ? '' : 'disabled'}>
            <b>${esc(LEVER_LABELS[l.lever] || l.lever)}</b> = ${esc(l.value)}<br><q>${esc(l.quote)}</q></label>`).join('') : '<p class="ip-muted">No provision matches a modeled lever.</p>'}
          ${b.not_modeled?.length ? `<details><summary>Not modeled (${b.not_modeled.length})</summary><ul>${b.not_modeled.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></details>` : ''}` : ''}
      </details>`;
  }

  tabContext() {
    const c = this.context;
    if (!c) return '<p class="ip-muted">Decision context is unavailable.</p>';
    return `<div class="ip-ctx">
      <h4>Who uses this</h4>
      <ul>${c.audiences.map((a) => `<li><b>${esc(a.who)}</b>${a.primary ? ' <span class="ip-badge">Primary</span>' : ''}: ${esc(a.decides)}. <span class="ip-muted">${esc(a.output)}.</span></li>`).join('')}</ul>
      <h4>Committees</h4>
      <ul>${c.committees.map((m) => `<li><b>${esc(m.name)}</b>: ${esc(m.role)}</li>`).join('')}</ul>
      <h4>Legal context</h4>
      <ul>${c.legal_context.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <h4>Source types</h4>
      <p>${Object.keys(TAGS).map(tag).join(' ')}</p>
      <ul>${c.rules.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <p class="ip-muted">As of ${esc(c.as_of)}.</p></div>`;
  }

  // ------------------------------------------------------------ results
  renderBody() {
    const r = this.s.result, body = this.el.querySelector('.ip-body'), sum = this.el.querySelector('.ip-summary');
    if (!body) return;
    const sm = this.s.summary;
    sum.innerHTML = !sm ? '' : sm.summary ? `<p>${esc(sm.summary)}</p><p class="ip-muted">Written by Gemini from the engine output; every number was checked against it.</p>`
      : sm.error ? `<p class="ip-err">Summary unavailable: ${esc(sm.error)}</p>`
      : `<p class="ip-err">Summary withheld: it used numbers the engine did not produce (${esc((sm.rejected_numbers || []).join(', '))}).</p>`;
    if (!r) { body.innerHTML = '<p class="ip-muted">Computing…</p>'; return; }
    if (r.error) { body.innerHTML = `<p class="ip-err">${esc(r.error)}</p>`; return; }
    if (!r.projects.length) { body.innerHTML = '<p class="ip-muted">Select a project, or drop one on the map.</p>'; return; }
    if (r.branch === 'not_built') {
      body.innerHTML = `<div class="ip-note"><b>Not built here.</b> Water stays in its current use; how much that use consumes is not yet known. If a project relocates, its impacts move elsewhere: <b>unknown, not zero</b>. No source quantifies this for Utah.</div>`;
      return;
    }
    const t = r.totals, ok = r.projects.filter((p) => p.water_af);
    const figs = ok.flatMap((p) => (p.water_af.figures || []).map((f) => ({ ...f, project: p.name })));
    const highest = Math.max(0, ...ok.map((p) => p.water_af.published_high || 0));
    const ov = r.projects.map((p) => p.overlaps || {});
    const sumKey = (k) => (ov.some((o) => k in o) ? ov.reduce((a, o) => a + (o[k] || 0), 0) : null);
    const nq = '<span class="ip-nq">Layer not loaded (run scripts/atlas/fetch_layers.py)</span>';
    const removed = r.lever_log.filter((l) => l.effect === 'removed').map((l) => l.project);
    const unsized = r.projects.filter((p) => p.error);
    body.innerHTML = `
      ${this.row('Water', 'acre-feet per year consumed', t.water_af, `
        <table class="ip-three"><tr><th>Developer or agency says</th><th>Engine estimate</th><th>Highest on record</th></tr>
        <tr><td>${t.stated_af ? `${fmt(t.stated_af)} ${tag('dev')}` : '<span class="ip-nq">Not published</span>'}</td><td>${rng(t.water_af)} ${tag('der')}</td><td>${highest ? fmt(highest) : '<span class="ip-nq">None published</span>'}</td></tr></table>
        ${ok.length > 1 ? `<table class="ip-three ip-per"><tr><th>Project</th><th>Says</th><th>Engine</th><th>Highest</th></tr>${ok.map((p) => `<tr><td>${esc(p.name)}</td><td>${fmt(p.water_af.stated)}</td><td>${rng(p.water_af.total)}</td><td>${fmt(p.water_af.published_high)}</td></tr>`).join('')}</table>` : ''}
        <div class="ip-muted">Water rights held or sought: ${fmt(t.rights_af)} AF</div>
        ${figs.length ? `<h5>Published figures</h5><ul class="ip-figs">${figs.map((f) => `<li>${fmt(f.value_af)} AF/yr: ${esc(f.label)} ${f.source_types.map(tag).join('')}
          ${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.source)}</a>` : `<span class="ip-muted">${esc(f.source)}</span>`}</li>`).join('')}</ul>` : ''}
        <h5>Net change vs. current land use (EO 2026-03)</h5>
        ${ok.map((p) => `<div class="ip-eo"><b>${esc(p.name)}</b>: ${esc(p.water_af.eo_2026_03_test)}</div>`).join('')}
        ${ok.some((p) => p.reporting_visible != null) ? `<h5>Reporting threshold</h5>${ok.map((p) => `<div class="ip-eo">${esc(p.name)}: ${p.reporting_visible ? 'would report' : 'below the threshold'}</div>`).join('')}<div class="ip-muted">Reporting changes what the state knows, not water use.</div>` : ''}`)}
      ${this.row('Great Salt Lake and dust', 'ft lower, long run', t.gsl.level_drop_ft, `
        <div>Extra exposed lakebed: ${rng(t.gsl.playa_acres)} acres</div>
        <div class="ip-muted">${esc(t.gsl.note)} Counts only projects that drain to the lake. The map band has the estimated area, not the real shape.</div>`, 'ft')}
      ${this.row('Air and climate', 'short tons CO₂ per year from on-site gas', t.co2_tons, `
        <div>NOx: ${rng(t.nox_tons)} short tons/yr</div>
        <div class="ip-muted">Grid power is not zero impact: grid-powered projects move emissions off-site, which is not modeled. Health damages are not computed here; the Stratos pilot shows published, contested figures with their sources.</div>`)}
      ${this.flag('Biodiversity', sumKey('gbif_hexes') == null ? nq : `${fmt(sumKey('species_records_near'))} species records within buffer · ${fmt(sumKey('critical_habitat_features') ?? 0)} critical-habitat features`)}
      ${this.flag('Wildfire', sumKey('fire_perimeters_since_2020') == null && sumKey('fire_detections_7d') == null ? nq : `${fmt(sumKey('fire_perimeters_since_2020') ?? 0)} perimeters since 2020 · ${fmt(sumKey('fire_detections_7d') ?? 0)} detections (7 days) near sites`)}
      ${this.flag('Pollution', sumKey('tri_facilities') == null ? nq : `${fmt(sumKey('tri_facilities'))} TRI facilities near sites`)}
      <p class="ip-muted">Overlap flags count features near a site. An overlap is not a harm.</p>
      ${removed.length ? `<p class="ip-muted">Removed by county moratoria: ${esc(removed.join(', '))}.</p>` : ''}
      ${unsized.length ? `<p class="ip-muted">Size unknown, not computed: ${esc(unsized.map((p) => p.name).join(', '))}.</p>` : ''}
      ${r.lever_log.length ? `<details class="ip-levers"><summary>Levers applied (${r.lever_log.length})</summary><ul>${r.lever_log.map((l) => `<li>${esc(l.project)}: ${esc(LEVER_LABELS[l.lever] || l.lever)} → ${esc(l.effect)}</li>`).join('')}</ul></details>` : ''}
      ${this.s.math ? this.math(r) : ''}`;
  }

  row(title, unit, [lo, c, hi], detail, suffix = '') {
    const pct = (v) => (hi > 0 ? Math.max(0, Math.min(100, (v / hi) * 100)) : 0);
    return `<details class="ip-row" open><summary><span class="ip-title">${title}</span>
      <span class="ip-val">${fmt(c)}${suffix ? ' ' + suffix : ''}</span><span class="ip-badge">Computed</span>
      <span class="ip-bar" role="img" aria-label="range ${fmt(lo)} to ${fmt(hi)}, central ${fmt(c)}"><span class="ip-span" style="left:${pct(lo)}%;width:${pct(hi) - pct(lo)}%"></span><span class="ip-mark" style="left:${pct(c)}%"></span></span>
      <span class="ip-unit">${unit} · range ${fmt(lo)}–${fmt(hi)}</span></summary><div class="ip-detail">${detail}</div></details>`;
  }
  flag(title, text) {
    return `<div class="ip-row ip-flagrow"><span class="ip-title">${title}</span><span class="ip-badge">Overlap flag</span><div class="ip-detail">${text}</div></div>`;
  }
  math(r) {
    return `<div class="ip-math-box"><h4>Formulas</h4><ul>
      <li>Site water, AF = (MW ÷ PUE) × 8,760 h × load factor × 1,000 × WUE ÷ 1,233,482 L/AF</li>
      <li>Gas plant water, AF = MW × 8,760 × load factor × gal/MWh ÷ 325,851 gal/AF</li>
      <li>Lake level, ft ≈ net depletion ÷ 100,000 × ft-per-100k-AF; lakebed = ft × acres-per-ft</li>
      <li>Unknown cooling: central closed-loop, high evaporative. Unknown on-site gas: low grid, central and high gas.</li></ul>
      <h4>Factors</h4><table><tr><th>Factor</th><th>Low</th><th>Central</th><th>High</th><th>Source</th></tr>
      ${Object.entries(r.factors).map(([k, f]) => `<tr><td>${esc(k)}</td><td>${f.low}</td><td>${f.central}</td><td>${f.high}</td><td>${esc(f.source)}</td></tr>`).join('')}</table>
      <h4>Per project</h4>${r.projects.map((p) => p.water_af ? `<p><b>${esc(p.name)}</b>: cooling ${esc(p.assumptions.cooling)}; on-site gas ${esc(p.assumptions.onsite_gas)}; power cooling ${esc(p.assumptions.power_cooling)}.
      Site ${rng(p.water_af.site)} + power ${rng(p.water_af.power)} AF/yr.</p>` : '').join('')}</div>`;
  }

  citation() {
    const r = this.s.result;
    if (!r?.totals) return '';
    const lines = [
      `YOUtah Environmental Atlas, impact engine estimate. Generated ${new Date().toISOString().slice(0, 10)} at ${location.origin}`,
      `Scenario: ${BRANCHES[r.branch]}${r.branch === 'scaled' ? ` (${this.s.scale * 100}% of announced size)` : ''}`,
      `Levers: ${JSON.stringify(this.s.branch === 'built' ? {} : this.s.levers)}`,
      '',
    ];
    if (r.branch === 'not_built') lines.push('Not built here: water stays in current use (not quantified); relocation impacts unknown, not zero.');
    for (const p of r.projects.filter((x) => x.water_af)) {
      const w = p.water_af;
      lines.push(`${p.name} (${p.county} County; ${p.basin})`,
        `  Assumptions: cooling ${p.assumptions.cooling}; on-site gas ${p.assumptions.onsite_gas}; power cooling ${p.assumptions.power_cooling}`,
        `  Engine water (Derived): ${fmt(w.total[1])} AF/yr, range ${fmt(w.total[0])}-${fmt(w.total[2])} (site ${fmt(w.site[1])} + power plant ${fmt(w.power[1])})`,
        `  Developer stated: ${fmt(w.stated)} AF/yr; rights held or sought: ${fmt(w.rights)} AF; highest on record: ${fmt(w.published_high)} AF/yr`,
        `  Net change vs current land use (EO 2026-03): ${w.eo_2026_03_test}`,
        ...(w.figures || []).map((f) => `  Published: ${fmt(f.value_af)} AF/yr, ${f.label} [${f.source_types.map((k) => TAGS[k]).join(', ')}] ${f.source}${f.url ? ' ' + f.url : ''}`));
    }
    if (r.branch !== 'not_built') {
      const t = r.totals;
      lines.push('', `Total water: ${fmt(t.water_af[1])} AF/yr (range ${fmt(t.water_af[0])}-${fmt(t.water_af[2])}); stated ${fmt(t.stated_af)}; rights ${fmt(t.rights_af)}`,
        `Great Salt Lake: ${fmt(t.gsl.level_drop_ft[1])} ft lower long-run (range ${fmt(t.gsl.level_drop_ft[0])}-${fmt(t.gsl.level_drop_ft[2])}); exposed lakebed ${fmt(t.gsl.playa_acres[1])} acres`,
        `CO2 from on-site gas: ${fmt(t.co2_tons[1])} short tons/yr (range ${fmt(t.co2_tons[0])}-${fmt(t.co2_tons[2])}); NOx ${fmt(t.nox_tons[1])}`);
    }
    lines.push('', 'Factors (low/central/high: source):', ...Object.entries(r.factors).map(([k, f]) => `  ${k}: ${f.low}/${f.central}/${f.high}: ${f.source}`),
      '', 'Estimates from published factor ranges, not measurements. The high end stacks every worst-case input. Coordinates are approximate.',
      'Basin baselines are placeholders until Division of Water Rights / Water Resources data is loaded.');
    return lines.join('\n');
  }
  download() {
    const text = this.citation();
    if (!text) return;
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })),
      download: `youtah-atlas-citation-${new Date().toISOString().slice(0, 10)}.txt`,
    });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
