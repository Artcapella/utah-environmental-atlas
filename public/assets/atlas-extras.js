// Environmental Atlas — bill library, four-branch strip and assistant actions for the Impact Panel.
//
// Kept apart from atlas-panel.js so the panel stays readable: installExtras(ImpactPanel) adds these methods
// to the class. The panel calls billLibraryHtml() / bindExtras(box) from its Legislation tab and initExtras()
// once after loading. runAtlasActions() is what the assistant (map-guide.js) calls to move the map.
import { BranchStrip } from './atlas-compare.js';

const TAGS = { gov: 'Government', dev: 'Developer', ind: 'Independent academic', adv: 'Advocacy-commissioned', der: 'Derived' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lower = (list) => (list || []).map((c) => String(c).toLowerCase());

const extras = {
  /** Called once from init(): load the bill library and wire the buttons that live outside the tab body. */
  initExtras() {
    this.bills = [];
    this.s.bills = this.s.bills || [];   // ids of applied measures that set no lever (nothing in s.levers to derive them from)
    this.billsReady = fetch(`${this.api}/bills`).then((r) => (r.ok ? r.json() : [])).then((b) => {
      this.bills = b;
      if (this.s.tab === 'legislation') this.renderTab();
      this.renderMapCard();
    }).catch(() => {});
    this.el.addEventListener('click', (e) => {
      if (e.target.closest('.ip-branches')) this.openCompare();
    });
    this.mapCard?.addEventListener('click', (e) => {
      if (e.target.closest('[data-open-branches]')) this.openCompare();
    });
  },

  /** A bill counts as applied when every lever it sets is in force (so unticking a lever by hand un-applies it). */
  billApplied(b) {
    const L = this.s.levers, keys = Object.keys(b.levers);
    if (!keys.length) return this.s.bills.includes(b.id);
    if (this.s.branch === 'built') return false;
    return keys.every((k) => (k === 'moratorium_counties'
      ? lower(b.levers[k]).every((c) => lower(L[k]).includes(c)) : same(L[k], b.levers[k])));
  },
  appliedBills() { return (this.bills || []).filter((b) => this.billApplied(b)); },

  applyBill(id) {
    const b = (this.bills || []).find((x) => x.id === id), s = this.s;
    if (!b) return false;
    for (const [k, v] of Object.entries(b.levers)) {
      s.levers[k] = k === 'moratorium_counties' ? [...new Set([...(s.levers[k] || []), ...v])] : v;
    }
    if (!Object.keys(b.levers).length) { if (!s.bills.includes(id)) s.bills.push(id); this.flash(`${b.label}: ${b.map_effect}`); }
    else if (s.branch === 'built') s.branch = 'conditions';
    this.render(); this.compute();
    return true;
  },
  removeBill(id) {
    const b = (this.bills || []).find((x) => x.id === id), s = this.s;
    if (!b) return;
    for (const [k, v] of Object.entries(b.levers)) {
      if (k === 'moratorium_counties') {
        const keep = (s.levers[k] || []).filter((c) => !lower(v).includes(String(c).toLowerCase()));
        if (keep.length) s.levers[k] = keep; else delete s.levers[k];
      } else if (same(s.levers[k], v)) delete s.levers[k];
    }
    s.bills = s.bills.filter((x) => x !== id);
    this.render(); this.compute();
  },
  clearBills() { this.s.levers = {}; this.s.bills = []; this.render(); this.compute(); },

  billLibraryHtml() {
    const bills = this.bills || [];
    if (!bills.length) return '';
    const card = (b) => {
      const on = this.billApplied(b);
      return `<div class="ip-bill${on ? ' on' : ''}">
        <div class="ip-bill-head"><b>${esc(b.label)}</b> ${b.real ? `<span class="ip-tag ${esc(b.source_type)}">${esc(TAGS[b.source_type] || b.source_type)}</span>` : '<span class="ip-badge ip-mock">Mock</span>'}
          <button data-bill="${esc(b.id)}" aria-pressed="${on}">${on ? 'Remove' : 'Apply to map'}</button></div>
        <div>${esc(b.title)}</div>
        <div class="ip-muted">${esc(b.status)}</div>
        <details><summary>What it does and what the map shows</summary>
          <p>${esc(b.summary)}</p>
          <p><b>On the map:</b> ${esc(b.map_effect)}</p>
          ${b.not_modeled.length ? `<p><b>Not modeled:</b></p><ul>${b.not_modeled.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          <p class="ip-muted">${esc(b.basis)} Source: ${b.source.url ? `<a href="${esc(b.source.url)}" target="_blank" rel="noopener">${esc(b.source.name)}</a>` : esc(b.source.name)}.</p>
        </details></div>`;
    };
    const real = bills.filter((b) => b.real), mock = bills.filter((b) => !b.real);
    return `<h5>Bill library</h5>
      <p class="ip-muted">Apply a measure to draw its effect on the map: red rings show each project built as planned, dark rings with the measure. Real measures are summaries of coverage and agency documents, not bill text.</p>
      <div class="ip-bills">${real.map(card).join('')}</div>
      <h5>Illustrations (not real legislation)</h5>
      <div class="ip-bills">${mock.map(card).join('')}</div>
      <h5>Set levers by hand</h5>`;
  },

  /** Called from renderTab(box) after the tab's HTML is in place. */
  bindExtras(box) {
    box.querySelectorAll('[data-bill]').forEach((n) => n.addEventListener('click', () => {
      const b = this.bills.find((x) => x.id === n.dataset.bill);
      this.billApplied(b) ? this.removeBill(b.id) : this.applyBill(b.id);
    }));
  },

  /** Extra lines under the map headline card: which measures are applied, and the way into the branch strip. */
  decorateMapCard() {
    const card = this.mapCard;
    if (!card || card.hidden) return;
    const applied = this.appliedBills();
    const noEffect = applied.filter((b) => !Object.keys(b.levers).length);
    card.insertAdjacentHTML('beforeend', `
      ${applied.length ? `<div class="amc-lv">Measures applied: ${applied.map((b) => `<b>${esc(b.label)}</b>${b.real ? '' : ' (mock)'}`).join(' · ')}</div>` : ''}
      ${noEffect.map((b) => `<div class="amc-k">${esc(b.label)}: ${esc(b.map_effect)}</div>`).join('')}
      ${'reporting_threshold_af' in this.s.levers && this.s.branch !== 'built' ? '<div class="amc-k">A reporting rule changes what the state knows, not water use. Labels show which projects would report.</div>' : ''}
      <div class="amc-foot"><button class="amc-btn" data-open-branches>Compare four branches on the map</button></div>`);
  },

  openCompare(projectId) {
    this.strip = this.strip || new BranchStrip(this);
    const pid = projectId || [...this.s.selected].find((id) => this.projects.some((p) => p.id === id)) || 'stratos';
    return this.strip.open(pid);
  },

  /** Scroll the panel to its top, to a result row (by title) or to an element, and outline it briefly. Used by the tour. */
  reveal({ top, row, sel }) {
    clearTimeout(this._rv);
    if (top) { this.el.closest('.sheet-body')?.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const find = () => (row ? [...this.el.querySelectorAll('.ip-row .ip-title')].find((n) => n.textContent.trim() === row)?.closest('.ip-row')
      : this.el.querySelector(sel));
    let tries = 0;
    const tick = () => {
      const n = find();
      if (!n) { if (++tries < 12) this._rv = setTimeout(tick, 300); return; }
      n.scrollIntoView({ block: 'start', behavior: 'smooth' });
      n.classList.add('ip-spot');
      setTimeout(() => n.classList.remove('ip-spot'), 2600);
    };
    this._rv = setTimeout(tick, 900);   // after the debounce and the engine round-trip, so the row is the fresh one
  },

  /** What the map is showing, for the assistant. */
  appState() {
    const s = this.s, hub = window.YOUtah;
    return {
      tab: document.querySelector('#tabs button.on')?.dataset.tab || null, impact_tab: s.tab,
      selected: [...s.selected], levers: s.branch === 'built' ? {} : s.levers, bills: this.appliedBills().map((b) => b.id),
      branch: s.branch, layers: hub ? [...hub.state.layers].filter((id) => id.startsWith('atlas-')) : [],
    };
  },
};

export function installExtras(ImpactPanel) {
  Object.assign(ImpactPanel.prototype, extras);
  const renderMapCard = ImpactPanel.prototype.renderMapCard;
  ImpactPanel.prototype.renderMapCard = function () {
    renderMapCard.call(this);
    this.decorateMapCard();
    this.strip?.refresh();   // keep the branch strip in step with the panel's levers and scenario
  };
}

const PANEL_ACTIONS = new Set(['impact_tab', 'select_projects', 'set_branch', 'apply_bill', 'set_levers', 'clear_levers', 'open_compare', 'close_compare',
  'show_math', 'set_basin', 'focus']);   // the last three come only from the guided tour (atlas-tour.js)

/**
 * Run assistant actions (validated server-side by backend/atlas/assistant.py clean_actions).
 * @param getPanel () => ImpactPanel (mounts it on first use)
 * @returns labels of the actions that ran
 */
export async function runAtlasActions(actions, { hub, getPanel }) {
  const done = [];
  const impactTab = () => document.querySelector('#tabs [data-tab="impact"]');
  const openImpact = () => { if (!impactTab()?.classList.contains('on')) impactTab()?.click(); };
  let panel = null;
  if ((actions || []).some((a) => PANEL_ACTIONS.has(a.type))) {
    openImpact();
    panel = getPanel();
    await panel.ready;
    await panel.billsReady;
  }
  let dirty = false, basins = false, focus = null;
  for (const a of actions || []) {
    const s = panel?.s;
    try {
      if (a.type === 'open_tab') { const b = document.querySelector(`#tabs [data-tab="${a.tab}"]`); if (b && !b.classList.contains('on')) b.click(); }
      else if (a.type === 'set_layer') { if (hub.state.layers.has(a.id) !== (a.on !== false)) hub.setLayer(a.id, a.on !== false); }
      else if (a.type === 'inversion_card') document.getElementById('inv')?.classList.toggle('collapsed', !a.open);
      else if (a.type === 'show_math') { if (s.math !== !!a.on) { s.math = !!a.on; dirty = true; } }
      else if (a.type === 'set_basin') { if (a.dry != null && s.basin.dry !== a.dry) { s.basin.dry = a.dry; basins = true; } }
      else if (a.type === 'focus') focus = a;
      else if (a.type === 'fly_to') hub.map?.flyTo({ center: [a.lng, a.lat], zoom: a.zoom || 8 });
      else if (a.type === 'impact_tab') { s.tab = a.tab; dirty = true; }
      else if (a.type === 'select_projects') { s.selected = new Set(a.ids.filter((id) => panel.projects.some((p) => p.id === id))); dirty = true; }
      else if (a.type === 'set_branch') { s.branch = a.branch; dirty = true; }
      else if (a.type === 'set_levers') { Object.assign(s.levers, a.levers); if (s.branch === 'built') s.branch = 'conditions'; dirty = true; }
      else if (a.type === 'clear_levers') { s.levers = {}; s.bills = []; if (s.branch === 'conditions') s.branch = 'built'; dirty = true; }
      else if (a.type === 'apply_bill') { if (!panel.applyBill(a.bill_id)) continue; dirty = false; }
      else if (a.type === 'open_compare') { if (dirty) { panel.render(); panel.compute(); dirty = false; } await panel.openCompare(a.project_id); }
      else if (a.type === 'close_compare') panel.strip?.close();
      else continue;   // open_briefing and start_tour are handled by the chat itself
      if (a.label) done.push(a.label);
    } catch (e) { console.warn('Atlas action failed:', a, e); }
  }
  if (dirty && panel) { panel.render(); panel.renderBody(); panel.setActive(panel.isActive()); panel.compute(); }
  if (basins && panel) panel.updateBasins();
  if (focus && panel) panel.reveal(focus);
  return done;
}
