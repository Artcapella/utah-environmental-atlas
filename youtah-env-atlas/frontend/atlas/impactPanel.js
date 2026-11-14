// Impact Panel — vanilla JS, no build step. Talks to /api/atlas/* (backend/routes/atlas_impact.py).
//
//   import { ImpactPanel } from './atlas/impactPanel.js';
//   const panel = new ImpactPanel(document.getElementById('impact-panel'), { map, api: '/api/atlas' });
//
// Design rules carried from the design doc and the Stratos pilot:
//   ranges always · stated vs computed vs highest-on-record side by side · source-type tags with
//   distinct outlines (not color-only) · "not quantified" shown, never zero · no net score.
import { updateScenarioOverlays, setPlayaScenario } from './layers.js';

const TAGS = { gov: 'Government', dev: 'Developer', ind: 'Independent academic', adv: 'Advocacy-commissioned', der: 'Derived (our arithmetic)' };
const BRANCHES = { built: 'Built as planned', conditions: 'Built with conditions', scaled: 'Delayed or scaled down', not_built: 'Not built here' };
const LEVER_LABELS = {
  cooling_required: 'Closed-loop cooling required', power_cooling_required: 'Dry-cooled power plants required',
  onsite_gas_allowed: 'On-site gas allowed', max_wue: 'Max WUE (L/kWh)', gsl_offset_ratio: 'GSL offset (AF per AF used)',
  moratorium_counties: 'County moratoria', habitat_setback_km: 'Habitat setback (km)', reporting_threshold_af: 'Reporting threshold (AF/yr)',
};
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class ImpactPanel {
  constructor(el, { map = null, api = '/api/atlas', briefingUrl = '/atlas/briefing.html' } = {}) {
    Object.assign(this, { el, map, api, briefingUrl });
    this.s = { tab: 'proposed', selected: new Set(['stratos']), branch: 'built', scale: 0.5, sizes: {},
               levers: {}, custom: [], math: false, result: null, summary: null, bill: null,
               drop: { mw: 300, cooling: 'evaporative', onsite_gas: false, gsl_basin: true } };
    el.classList.add('ip');
    this.init();
  }

  async init() {
    this.projects = await (await fetch(`${this.api}/projects`)).json();
    if (this.map) this.map.on('click', (e) => this.onMapClick(e));
    this.render();
    this.compute();
  }

  // ------------------------------------------------------------ data
  body(extra = {}) {
    const s = this.s;
    return { project_ids: [...s.selected], custom: s.custom, levers: s.branch === 'built' ? {} : s.levers,
             branch: s.branch, scale: s.scale, sizes: s.sizes, ...extra };
  }
  async post(path, body) {
    const r = await fetch(`${this.api}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
  async compute() {
    clearTimeout(this._t);
    this._t = setTimeout(async () => {
      try {
        this.s.result = await this.post('/impact', this.body());
        this.s.summary = null;
        if (this.map) updateScenarioOverlays(this.map, await this.post('/overlays', this.body()));
        if (this.map) setPlayaScenario(this.map, '__none__');   // hide static band; scenario band takes over
      } catch (e) { this.s.result = { error: String(e) }; }
      this.renderBody();
    }, 150);
  }
  async explain() {
    this.el.querySelector('.ip-summary').textContent = 'Writing summary…';
    try { this.s.summary = (await this.post('/impact', this.body({ explain: true }))).summary; }
    catch (e) { this.s.summary = { summary: null, error: String(e) }; }
    this.renderBody();
  }
  async parseBill(text) {
    this.s.bill = { loading: true };
    this.renderTab();
    try { this.s.bill = await this.post('/extract/bill', { text }); }
    catch (e) { this.s.bill = { error: String(e) }; }
    this.renderTab();
  }
  onMapClick(e) {
    if (this.s.tab !== 'drop') return;
    const d = this.s.drop;
    this.s.custom.push({ name: `Dropped ${d.mw} MW`, lat: e.lngLat.lat, lon: e.lngLat.lng, mw: +d.mw,
                         cooling: d.cooling, onsite_gas: d.onsite_gas, gsl_basin: d.gsl_basin });
    this.renderTab(); this.compute();
  }

  // ------------------------------------------------------------ shell
  render() {
    this.el.innerHTML = `
      <div class="ip-head">
        <div class="ip-tabs" role="tablist">
          ${['proposed', 'drop', 'legislation'].map((t) => `<button role="tab" data-tab="${t}" aria-selected="${this.s.tab === t}">${{ proposed: 'Proposed', drop: 'Drop a project', legislation: 'Legislation' }[t]}</button>`).join('')}
        </div>
        <div class="ip-branch" role="group" aria-label="Scenario">
          ${Object.entries(BRANCHES).map(([k, v]) => `<button data-branch="${k}" aria-pressed="${this.s.branch === k}">${v}</button>`).join('')}
        </div>
        <div class="ip-tabbody"></div>
      </div>
      <div class="ip-summary" aria-live="polite"></div>
      <div class="ip-body"></div>
      <div class="ip-foot">
        <label><input type="checkbox" class="ip-math" ${this.s.math ? 'checked' : ''}> Show the math</label>
        <button class="ip-explain">Plain-language summary</button>
        <button class="ip-copy">Copy citation</button>
        <a href="${this.briefingUrl}" target="_blank" rel="noopener">Legislative briefing</a>
      </div>`;
    this.el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { this.s.tab = b.dataset.tab; this.render(); this.renderBody(); }));
    this.el.querySelectorAll('[data-branch]').forEach((b) => (b.onclick = () => { this.s.branch = b.dataset.branch; this.render(); this.compute(); }));
    this.el.querySelector('.ip-math').onchange = (e) => { this.s.math = e.target.checked; this.renderBody(); };
    this.el.querySelector('.ip-explain').onclick = () => this.explain();
    this.el.querySelector('.ip-copy').onclick = () => navigator.clipboard.writeText(this.citation());
    this.renderTab();
  }

  renderTab() {
    const s = this.s, box = this.el.querySelector('.ip-tabbody');
    let html = '';
    if (s.tab === 'proposed') {
      html = `<div class="ip-list">${this.projects.map((p) => `
        <label><input type="checkbox" data-pid="${p.id}" ${s.selected.has(p.id) ? 'checked' : ''}>
          ${esc(p.name)} <span class="ip-muted">${esc(p.county)} · ${fmt(p.mw)} MW</span></label>
        ${Object.keys(p.size_options_mw || {}).length ? `<select data-size="${p.id}" class="ip-size"><option value="">Size: as announced</option>
          ${Object.entries(p.size_options_mw).map(([k, v]) => `<option value="${v}" ${s.sizes[p.id] == v ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>` : ''}`).join('')}</div>
        <div class="ip-row-btns"><button data-all>All</button><button data-none>None</button></div>`;
    } else if (s.tab === 'drop') {
      const d = s.drop;
      html = `<p class="ip-muted">Set the project, then click the map to place it.</p>
        <div class="ip-form">
          <label>Size (MW)<input type="number" min="1" data-d="mw" value="${d.mw}"></label>
          <label>Cooling<select data-d="cooling"><option value="evaporative" ${d.cooling === 'evaporative' ? 'selected' : ''}>Evaporative</option><option value="closed_loop" ${d.cooling === 'closed_loop' ? 'selected' : ''}>Closed-loop</option></select></label>
          <label><input type="checkbox" data-d="onsite_gas" ${d.onsite_gas ? 'checked' : ''}> On-site gas power</label>
          <label><input type="checkbox" data-d="gsl_basin" ${d.gsl_basin ? 'checked' : ''}> Drains to Great Salt Lake</label>
        </div>
        ${s.custom.map((c, i) => `<div class="ip-chip">${esc(c.name)} @ ${c.lat.toFixed(3)}, ${c.lon.toFixed(3)} <button data-rm="${i}" aria-label="Remove">×</button></div>`).join('')}`;
    } else {
      const b = s.bill;
      html = `<textarea class="ip-billtext" rows="5" placeholder="Paste bill text (or a summary of its provisions)"></textarea>
        <button class="ip-parse">Read bill</button>
        ${b?.loading ? '<p class="ip-muted">Reading…</p>' : ''}${b?.error ? `<p class="ip-err">${esc(b.error)}</p>` : ''}
        ${b?.levers ? `<p class="ip-muted">Confirm each lever before it applies. It applies under "Built with conditions" or "Delayed or scaled down".</p>
          ${b.levers.map((l, i) => `<label class="ip-lever"><input type="checkbox" data-lv="${i}" ${l.lever in s.levers ? 'checked' : ''}>
            <b>${esc(LEVER_LABELS[l.lever] || l.lever)}</b> = ${esc(l.value)}<br><q>${esc(l.quote)}</q></label>`).join('')}
          ${b.not_modeled?.length ? `<details><summary>Not modeled (${b.not_modeled.length})</summary><ul>${b.not_modeled.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></details>` : ''}` : ''}`;
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-pid]').forEach((c) => (c.onchange = () => { c.checked ? s.selected.add(c.dataset.pid) : s.selected.delete(c.dataset.pid); this.compute(); }));
    box.querySelectorAll('[data-size]').forEach((c) => (c.onchange = () => { c.value ? (s.sizes[c.dataset.size] = +c.value) : delete s.sizes[c.dataset.size]; this.compute(); }));
    box.querySelector('[data-all]')?.addEventListener('click', () => { this.projects.forEach((p) => s.selected.add(p.id)); this.renderTab(); this.compute(); });
    box.querySelector('[data-none]')?.addEventListener('click', () => { s.selected.clear(); this.renderTab(); this.compute(); });
    box.querySelectorAll('[data-d]').forEach((c) => (c.onchange = () => { s.drop[c.dataset.d] = c.type === 'checkbox' ? c.checked : c.value; }));
    box.querySelectorAll('[data-rm]').forEach((c) => (c.onclick = () => { s.custom.splice(+c.dataset.rm, 1); this.renderTab(); this.compute(); }));
    box.querySelector('.ip-parse')?.addEventListener('click', () => this.parseBill(box.querySelector('.ip-billtext').value));
    box.querySelectorAll('[data-lv]').forEach((c) => (c.onchange = () => {
      const l = s.bill.levers[+c.dataset.lv];
      if (c.checked) s.levers[l.lever] = s.bill.levers_dict[l.lever]; else delete s.levers[l.lever];
      if (c.checked && s.branch === 'built') { s.branch = 'conditions'; this.render(); }
      this.compute();
    }));
  }

  // ------------------------------------------------------------ results
  renderBody() {
    const r = this.s.result, body = this.el.querySelector('.ip-body'), sum = this.el.querySelector('.ip-summary');
    const sm = this.s.summary;
    sum.innerHTML = sm ? (sm.summary ? `<p>${esc(sm.summary)}</p>` : `<p class="ip-err">Summary withheld: it contained numbers the engine did not produce${sm.error ? ` (${esc(sm.error)})` : ''}.</p>`) : '';
    if (!r) { body.innerHTML = '<p class="ip-muted">Computing…</p>'; return; }
    if (r.error) { body.innerHTML = `<p class="ip-err">${esc(r.error)}</p>`; return; }
    const t = r.totals;
    if (r.branch === 'not_built') {
      body.innerHTML = `<div class="ip-note"><b>Not built here.</b> Water stays in its current use; its current consumptive use is not known. If a project relocates, its impacts move elsewhere: <b>unknown, not zero</b>. No source quantifies this for Utah.</div>`;
      return;
    }
    const figs = r.projects.flatMap((p) => (p.water_af?.figures || []).map((f) => ({ ...f, project: p.name })));
    const highest = Math.max(0, ...r.projects.map((p) => p.water_af?.published_high || 0));
    const ov = r.projects.map((p) => p.overlaps || {});
    const sumKey = (k) => (ov.some((o) => k in o) ? ov.reduce((a, o) => a + (o[k] || 0), 0) : null);
    const nq = '<span class="ip-nq">Not loaded. Run scripts/fetch_layers.py</span>';
    body.innerHTML = `
      ${this.row('Water', 'AF/yr consumed', t.water_af, `
        <table class="ip-three"><tr><th>Developer or agency says</th><th>Engine estimate</th><th>Highest on record</th></tr>
        <tr><td>${fmt(t.stated_af)}</td><td>${fmt(t.water_af[1])} <span class="ip-muted">(${fmt(t.water_af[0])}–${fmt(t.water_af[2])})</span></td><td>${highest ? fmt(highest) : '<span class="ip-nq">None published</span>'}</td></tr></table>
        <div class="ip-muted">Water rights held or sought: ${fmt(t.rights_af)} AF</div>
        ${figs.length ? `<ul class="ip-figs">${figs.map((f) => `<li>${fmt(f.value_af)} AF/yr: ${esc(f.label)} ${f.source_types.map((k) => `<span class="tag ${k}">${TAGS[k]}</span>`).join('')}
          ${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">source</a>` : `<span class="ip-muted">${esc(f.source)}</span>`}</li>`).join('')}</ul>` : ''}
        ${r.projects.map((p) => p.water_af ? `<div class="ip-eo"><b>${esc(p.name)}</b>, net change vs. current land use: ${esc(p.water_af.eo_2026_03_test)}</div>` : '').join('')}`)}
      ${this.row('Great Salt Lake and dust', 'ft lower (long run) · extra exposed lakebed', t.gsl.level_drop_ft, `
        <div>Exposed lakebed: ${fmt(t.gsl.playa_acres[1])} acres (${fmt(t.gsl.playa_acres[0])}–${fmt(t.gsl.playa_acres[2])})</div>
        <div class="ip-muted">${esc(t.gsl.note)} Counts only projects that drain to the lake.</div>`, 'ft')}
      ${this.row('Air and climate', 'short tons CO₂/yr from on-site gas', t.co2_tons, `
        <div>NOx: ${fmt(t.nox_tons[1])} tons/yr (${fmt(t.nox_tons[0])}–${fmt(t.nox_tons[2])})</div>
        <div class="ip-muted">Grid-powered projects move emissions off-site; those are not modeled. Health damages are not computed here. See the Stratos pilot for published, contested estimates.</div>`)}
      ${this.flag('Biodiversity', sumKey('gbif_hexes') == null ? nq : `${fmt(sumKey('species_records_near'))} species records within buffer · ${fmt(sumKey('critical_habitat_features') ?? 0)} critical-habitat features`)}
      ${this.flag('Wildfire', sumKey('fire_perimeters_since_2020') == null && sumKey('fire_detections_7d') == null ? nq : `${fmt(sumKey('fire_perimeters_since_2020') ?? 0)} perimeters since 2020 · ${fmt(sumKey('fire_detections_7d') ?? 0)} detections (7 days) near sites`)}
      ${this.flag('Pollution', sumKey('tri_facilities') == null ? nq : `${fmt(sumKey('tri_facilities'))} TRI facilities near sites`)}
      ${r.lever_log.length ? `<details class="ip-levers"><summary>Levers applied (${r.lever_log.length})</summary><ul>${r.lever_log.map((l) => `<li>${esc(l.project)}: ${esc(LEVER_LABELS[l.lever] || l.lever)} → ${esc(l.effect)}</li>`).join('')}</ul></details>` : ''}
      ${this.s.math ? this.math(r) : ''}`;
  }

  row(title, unit, [lo, c, hi], detail, suffix = '') {
    const pct = (v) => (hi > 0 ? Math.max(0, Math.min(100, (v / hi) * 100)) : 0);
    return `<details class="ip-row" open><summary><span class="ip-title">${title}</span>
      <span class="ip-val">${fmt(c)}${suffix ? ' ' + suffix : ''}</span><span class="ip-badge">Computed</span>
      <span class="ip-bar" aria-label="range ${fmt(lo)} to ${fmt(hi)}"><span class="ip-span" style="left:${pct(lo)}%;width:${pct(hi) - pct(lo)}%"></span><span class="ip-mark" style="left:${pct(c)}%"></span></span>
      <span class="ip-unit">${unit} · range ${fmt(lo)}–${fmt(hi)}</span></summary><div class="ip-detail">${detail}</div></details>`;
  }
  flag(title, text) {
    return `<div class="ip-row ip-flagrow"><span class="ip-title">${title}</span><span class="ip-badge">Overlap flag</span><div class="ip-detail">${text}</div></div>`;
  }
  math(r) {
    return `<div class="ip-math-box"><h4>Factors</h4><table><tr><th>Factor</th><th>Low</th><th>Central</th><th>High</th><th>Source</th></tr>
      ${Object.entries(r.factors).map(([k, f]) => `<tr><td>${k}</td><td>${f.low}</td><td>${f.central}</td><td>${f.high}</td><td>${esc(f.source)}</td></tr>`).join('')}</table>
      <h4>Per project</h4>${r.projects.map((p) => p.water_af ? `<p><b>${esc(p.name)}</b>: cooling ${esc(p.assumptions.cooling)}; on-site gas ${esc(p.assumptions.onsite_gas)}; power cooling ${esc(p.assumptions.power_cooling)}.
      Site ${fmt(p.water_af.site[1])} + power ${fmt(p.water_af.power[1])} AF/yr.</p>` : '').join('')}</div>`;
  }
  citation() {
    const r = this.s.result;
    if (!r?.totals) return '';
    return [`YOUtah Environmental Atlas, impact engine estimate (${new Date().toISOString().slice(0, 10)})`,
      `Scenario: ${BRANCHES[r.branch]}; projects: ${r.projects.map((p) => p.name).join(', ')}`,
      `Levers: ${JSON.stringify(this.s.branch === 'built' ? {} : this.s.levers)}`,
      `Water: ${fmt(r.totals.water_af[1])} AF/yr (range ${fmt(r.totals.water_af[0])}–${fmt(r.totals.water_af[2])}); developer stated ${fmt(r.totals.stated_af)}; rights ${fmt(r.totals.rights_af)}`,
      `GSL: ${r.totals.gsl.level_drop_ft[1]} ft long-run (range ${r.totals.gsl.level_drop_ft[0]}–${r.totals.gsl.level_drop_ft[2]})`,
      'Factors:', ...Object.entries(r.factors).map(([k, f]) => `  ${k}: ${f.low}/${f.central}/${f.high}: ${f.source}`),
      'Estimates only; baselines are placeholders until Division of Water Rights/Resources data is loaded.'].join('\n');
  }
}
