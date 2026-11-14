// Environmental Atlas — four-branch strip, docked over the map (map-first: choosing a card redraws the map).
//
// Columns: built as planned / built with conditions / delayed or scaled down / not built here.
// Cards carry the engine's water and lake estimates; the rows below add economics and environment with
// source-type tags. Rules (docs/atlas/design.md): ranges always, "Not quantified" rather than zero, no net
// score, and "not built here" is not zero impact. Data: POST /api/atlas/compare (backend/atlas/comparison.py).
const TAGS = { gov: 'Government', dev: 'Developer', ind: 'Independent academic', adv: 'Advocacy-commissioned', der: 'Derived' };
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tag = (k) => `<span class="ip-tag ${esc(k)}" title="Source type">${esc(TAGS[k] || k)}</span>`;

export class BranchStrip {
  /** @param panel ImpactPanel (reads its levers, sets its scenario) */
  constructor(panel) {
    this.panel = panel;
    this.el = Object.assign(document.createElement('section'), { id: 'atlasBranches', className: 'glass ip', hidden: true });
    this.el.setAttribute('aria-label', 'Four branches for one project');
    document.body.append(this.el);
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('change', (e) => {
      if (e.target.matches('.bs-project')) this.open(e.target.value);
      if (e.target.matches('.bs-notes')) { this.notes = e.target.checked; this.el.classList.toggle('bs-shownotes', this.notes); }
    });
    this.rows = !window.matchMedia('(max-width: 899px)').matches;   // rows start open on desktop
    this.notes = false;
  }

  get isOpen() { return !this.el.hidden; }

  async open(projectId) {
    this.pid = projectId || this.pid || 'stratos';
    this.el.hidden = false;
    document.body.classList.add('atlas-branches-open');
    if (!this.data || this.data.project.id !== this.pid) this.el.innerHTML = '<p class="ip-muted">Comparing four branches…</p>';
    await this.refresh(true);
    if (!this.data) return;
    const p = this.data.project, s = this.panel.s;
    if (s.selected.size !== 1 || !s.selected.has(p.id)) {   // the strip is about one project: put only it on the map
      s.selected = new Set([p.id]);
      this.panel.render();
      this.panel.compute();
    }
    // Keep the project (and the lake, for lake-draining ones) clear of the strip and the side panel.
    this.panel.map?.flyTo({ center: [p.lon, p.lat], zoom: p.gsl_basin ? 7.3 : 7.8, offset: [window.innerWidth > 899 ? 150 : 0, -140] });
  }

  close() {
    this.el.hidden = true;
    document.body.classList.remove('atlas-branches-open');
  }

  /** Re-fetch when the project or the panel's levers changed; otherwise just re-highlight the active card. */
  async refresh(force = false) {
    if (!this.isOpen) return;
    const levers = this.panel.s.levers, key = `${this.pid}|${JSON.stringify(levers)}`;
    if (force || key !== this.key) {
      this.key = key;
      try {
        const r = await fetch(`${this.panel.api}/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                             body: JSON.stringify({ project_id: this.pid, levers }) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        this.data = await r.json();
      } catch (e) {
        this.data = null;
        this.el.innerHTML = `<p class="ip-err">The comparison is unavailable (${esc(e.message)}).</p><button class="bs-close" aria-label="Close">×</button>`;
        return;
      }
    }
    this.render();
  }

  activeBranch() {
    const s = this.panel.s;
    return s.selected.size === 1 && s.selected.has(this.pid) ? s.branch : null;
  }

  onClick(e) {
    if (e.target.closest('.bs-close')) return this.close();
    if (e.target.closest('.bs-rows')) { this.rows = !this.rows; return this.render(); }
    const card = e.target.closest('[data-bs-branch]');
    if (card && this.data) this.show(card.dataset.bsBranch);
  }

  /** Draw one branch on the map by setting the panel's scenario. */
  show(branch) {
    const s = this.panel.s, d = this.data, pid = d.project.id;
    s.selected = new Set([pid]);
    s.branch = branch;
    delete s.sizes[pid];
    if (branch === 'conditions' && !Object.keys(s.levers).length) s.levers = { ...d.conditions_levers };   // the example pair shown on the card
    if (branch === 'scaled') { s.scale = 1; s.sizes[pid] = d.scaled_mw; }
    this.panel.render();
    this.panel.compute();
    this.render();
  }

  render() {
    const d = this.data;
    if (!d) return;
    const active = this.activeBranch();
    const top = Math.max(1, ...d.branches.map((b) => (b.water_af ? b.water_af[2] : 0)));
    const pct = (v) => Math.max(0, Math.min(100, (v / top) * 100));
    const card = (b) => {
      const w = b.water_af, g = b.level_drop_ft;
      const body = b.id === 'not_built'
        ? `<span class="bs-v">Not zero</span><span class="bs-k">Water stays in its current use (amount not known). If the project relocates, the impact moves: unknown.</span>`
        : !w ? `<span class="bs-v">—</span><span class="bs-k">Not computed in this scenario.</span>`
        : `<span class="bs-v">${fmt(w[1])}<small> AF/yr</small></span>
           <span class="ip-bar" role="img" aria-label="range ${fmt(w[0])} to ${fmt(w[2])}, central ${fmt(w[1])}"><span class="ip-span" style="left:${pct(w[0])}%;width:${pct(w[2]) - pct(w[0])}%"></span><span class="ip-mark" style="left:${pct(w[1])}%"></span></span>
           <span class="bs-k">water, range ${fmt(w[0])}–${fmt(w[2])}${d.project.gsl_basin ? ` · lake ${fmt(g[1])} ft lower (${fmt(g[0])}–${fmt(g[2])})` : ' · does not drain to the lake'}</span>`;
      return `<button class="bs-card" data-bs-branch="${b.id}" aria-pressed="${active === b.id}">
        <span class="bs-name">${esc(b.label)}</span>${body}<span class="bs-desc">${esc(b.description)}</span></button>`;
    };
    const cell = (c) => `<div class="bs-cell ${esc(c.kind)}">${c.kind === 'nq' ? `<span class="ip-nq">${esc(c.text)}</span>` : esc(c.text)} ${(c.tags || []).map(tag).join('')}
      ${c.source || c.note ? `<small class="bs-note">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.source)}</a>` : esc(c.source || '')}${c.source && c.note ? '. ' : ''}${esc(c.note || '')}</small>` : ''}</div>`;
    let group = null;
    const rows = d.rows.map((r) => {
      const head = r.group !== group ? `<tr class="bs-group"><th colspan="5">${esc(r.group)}</th></tr>` : '';
      group = r.group;
      return `${head}<tr><th scope="row">${esc(r.label)}</th>${d.branches.map((b) => `<td>${r.cells[b.id].map(cell).join('')}</td>`).join('')}</tr>`;
    }).join('');
    const projects = this.panel.projects || [];
    this.el.classList.toggle('bs-shownotes', this.notes);
    this.el.innerHTML = `
      <header class="bs-head">
        <b>Four branches</b>
        <select class="bs-project" aria-label="Project">${projects.map((p) => `<option value="${esc(p.id)}" ${p.id === d.project.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <span class="ip-muted bs-hint">Choose a card to draw that branch on the map. Estimates, not measurements.</span>
        <button class="bs-rows" aria-expanded="${this.rows}">${this.rows ? 'Hide rows' : 'Economics and environment rows'}</button>
        <button class="bs-close" aria-label="Close the four-branch strip">×</button>
      </header>
      <div class="bs-cards">${d.branches.map(card).join('')}</div>
      ${this.rows ? `<div class="bs-table">
        <label class="ip-check bs-notes-toggle"><input type="checkbox" class="bs-notes" ${this.notes ? 'checked' : ''}> Show sources and caveats for each figure</label>
        ${d.has_published ? '' : '<p class="ip-muted">No published economic or environmental figures were found for this project, so most cells read "Not quantified".</p>'}
        <table class="ip-three"><thead><tr><th></th>${d.branches.map((b) => `<th scope="col">${esc(b.label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
        <ul class="ip-muted bs-limits">${d.limits.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}`;
  }
}
