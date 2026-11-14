// Water Screen: screening model and the hand-off between the Atlas and /screen (public/atlas/water-screen.html).
//
// The screen is a second, simpler model than the impact engine (backend/atlas/engine.py): national-average
// coefficients, a utilization the reviewer sets, and grid power-plant water, which the engine does not count.
// The page shows both estimates side by side; nothing here feeds the map.
//
// Pure functions only (no DOM), so the panel can build links and node can test the mapping.

export const GAL_PER_AF = 325851;
const L_PER_GAL = 3.785;

// Cooling: litres per kWh of server energy (WUE). peak = peak-day multiplier on the annual average.
export const COOLING = {
  dry:    { label: 'Dry or closed-loop (air-cooled)', d: 'Recirculates sealed water; almost no evaporation, but uses more electricity.', lo: 0.02, mid: 0.1, hi: 0.2, peak: 1.1, drops: '●○○○' },
  hybrid: { label: 'Hybrid / adiabatic', d: 'Air-cooled most of the year; sprays water on hot days.', lo: 0.2, mid: 0.5, hi: 0.9, peak: 1.5, drops: '●●○○' },
  usavg:  { label: 'Unknown (use U.S. average)', d: "Federal average across today's data centers.", lo: 0.35, mid: 0.5, hi: 0.7, peak: 1.4, drops: '●●○○' },
  evap:   { label: 'Evaporative cooling towers', d: 'Evaporates water continuously; highest use, peaking in summer.', lo: 1.0, mid: 1.8, hi: 2.5, peak: 1.8, drops: '●●●●' },
};
// Power: gallons consumed per MWh generated.
export const POWER = {
  gasTurbine: { label: 'On-site natural gas turbines', d: 'Private power plant on the campus with water-cooled steam cycle.', lo: 150, mid: 234, hi: 300, drops: '●●○○' },
  gasRecip:   { label: 'On-site gas engines', d: 'Low water, but high air emissions.', lo: 10, mid: 28, hi: 60, drops: '●○○○' },
  grid:       { label: 'Utility grid / unknown', d: 'Water is used at power plants elsewhere; national average shown.', lo: 500, mid: 1160, hi: 1300, drops: '●●●●' },
  renew:      { label: 'New wind or solar contract', d: 'Near-zero operating water.', lo: 0, mid: 5, hi: 20, drops: '○○○○' },
};
export const UTILS = [50, 65, 80, 90];
export const SOURCE_TXT = {
  potable: 'city or district drinking water', newright: 'a new water right or change application',
  groundwater: 'an existing groundwater right', reclaimed: 'reclaimed or recycled water', unknown: 'not disclosed',
};
export const BASIN_TXT = { gsl: 'Great Salt Lake basin', colorado: 'Colorado River basin', sevier: 'Sevier River basin', other: 'an other or closed basin' };

export const DEFAULTS = {
  name: '', mw: 300, basis: 'facility', util: 65, pue: 1.3, cooling: 'usavg', power: 'grid',
  source: 'unknown', basin: 'other', request: null, reporting: false, confidential: false,
};

/** One case of the estimate. uShift moves utilization (in fractions); which = 'lo' | 'mid' | 'hi'. */
export function compute(p, uShift, which) {
  const u = Math.min(0.95, Math.max(0.2, p.util / 100 + uShift));
  const c = COOLING[p.cooling], w = POWER[p.power];
  let fac, it;
  if (p.basis === 'it') { it = p.mw * 8760 * u; fac = it * p.pue; } else { fac = p.mw * 8760 * u; it = fac / p.pue; }
  const directGal = (it * 1000 * c[which]) / L_PER_GAL;
  return { fac, direct: directGal / GAL_PER_AF, indirect: (fac * w[which]) / GAL_PER_AF, directGal };
}
/** Central case plus the low and high ends (±15 points of utilization with each option's low and high value). */
export const estimate = (p) => ({ mid: compute(p, 0, 'mid'), lo: compute(p, -0.15, 'lo'), hi: compute(p, 0.15, 'hi') });

// ---------------------------------------------------------------- Atlas registry -> screen inputs
const coolingFromEngine = (c) => ({ closed_loop: 'dry', evaporative: 'evap' })[c] || 'usavg';
const powerFromEngine = (gas) => (gas === true ? 'gasTurbine' : 'grid');
function basinFromAtlas(p) {
  if (p.gsl_basin) return 'gsl';
  const b = String(p.basin || '').toLowerCase();
  return b.includes('colorado') ? 'colorado' : b.includes('sevier') ? 'sevier' : 'other';
}
// Unknown stays unknown: the registry rarely records where a project's water comes from.
const sourceFromAtlas = (p) => (p.water_source === 'produced_water' ? 'reclaimed' : p.rights_af ? 'newright' : 'unknown');

/** A registry project (GET /api/atlas/projects) as screen inputs. Utilization and PUE start at the engine's central factors. */
export function fromAtlas(p) {
  return {
    ...DEFAULTS, name: `${p.name} (${p.county} County)`, mw: p.mw ?? 0, util: 80, pue: 1.3,
    cooling: coolingFromEngine(p.cooling), power: powerFromEngine(p.onsite_gas),
    source: sourceFromAtlas(p), basin: basinFromAtlas(p), request: p.stated_af ?? null,
  };
}

// ---------------------------------------------------------------- URL <-> inputs
/** Link from the map to the screen. Registry projects go by id; dropped projects carry their fields. */
export function screenUrl(project, { mw, base = '/screen' } = {}) {
  const q = new URLSearchParams();
  if (project.id && !String(project.id).startsWith('custom_')) {
    q.set('project', project.id);
    if (mw && mw !== project.mw) q.set('mw', mw);
  } else {
    if (project.name) q.set('name', project.name);
    q.set('mw', mw || project.mw);
    if (project.cooling) q.set('cooling', project.cooling);
    if (typeof project.onsite_gas === 'boolean') q.set('onsite_gas', project.onsite_gas ? '1' : '0');
    if (project.gsl_basin) q.set('gsl', '1');
  }
  return `${base}?${q}`;
}

/** Inputs from a query string. Accepts the screen's own keys and the engine's (cooling=closed_loop, onsite_gas=1, gsl=1). */
export function fromParams(q, projects = []) {
  const atlas = projects.find((x) => x.id === q.get('project')) || null;
  const p = atlas ? fromAtlas(atlas) : { ...DEFAULTS };
  const num = (k, lo, hi) => {
    const raw = q.get(k), v = Number(raw);
    return raw !== null && raw !== '' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
  };
  const pick = (k, table, alias = {}) => {
    const v = alias[q.get(k)] || q.get(k);
    return v !== null && Object.hasOwn(table, v) ? v : undefined;
  };
  const set = (k, v) => { if (v !== undefined) p[k] = v; };
  if (q.get('name')) p.name = q.get('name').slice(0, 80);
  set('mw', num('mw', 0.001, 50000));
  set('pue', num('pue', 1, 2.5));
  set('request', num('request', 0, 1e7));
  if (q.get('request') === '') p.request = null;   // the reviewer cleared a figure the registry had
  if (UTILS.includes(Number(q.get('util')))) p.util = Number(q.get('util'));
  if (q.get('basis') === 'it' || q.get('basis') === 'facility') p.basis = q.get('basis');
  set('cooling', pick('cooling', COOLING, { closed_loop: 'dry', evaporative: 'evap' }));
  set('power', pick('power', POWER) ?? (q.has('onsite_gas') ? powerFromEngine(q.get('onsite_gas') === '1') : undefined));
  set('source', pick('source', SOURCE_TXT));
  set('basin', pick('basin', BASIN_TXT) ?? (q.get('gsl') === '1' ? 'gsl' : undefined));
  if (q.has('reporting')) p.reporting = q.get('reporting') === '1';
  if (q.has('confidential')) p.confidential = q.get('confidential') === '1';
  return { p, atlas };
}

/** Shareable query string: only what differs from the starting point (the Atlas project, or the defaults). */
export function toParams(p, atlas = null) {
  const base = atlas ? fromAtlas(atlas) : DEFAULTS, q = new URLSearchParams();
  if (atlas) q.set('project', atlas.id);
  for (const k of Object.keys(DEFAULTS)) {
    if (p[k] === base[k] || (p[k] == null && base[k] == null)) continue;
    q.set(k, typeof p[k] === 'boolean' ? (p[k] ? '1' : '0') : p[k] ?? '');
  }
  return q;
}

// ---------------------------------------------------------------- screen inputs -> engine
/**
 * The same proposal as a custom project for POST /api/atlas/impact.
 * Where the reviewer has not changed a choice that came from the registry, the registry's own engine
 * fields are sent, so an untouched Atlas project gets exactly the estimate shown on the map.
 * The engine has no hybrid cooling (sent as unknown) and does not count grid or renewable power water.
 */
export function toEngine(p, atlas = null) {
  const base = atlas ? fromAtlas(atlas) : null;
  const kept = (k) => !!base && base[k] === p[k];
  const out = {
    name: (p.name || 'Screened project').slice(0, 80), county: atlas?.county || 'Unknown',
    lat: atlas?.lat ?? 39.3, lon: atlas?.lon ?? -111.7,
    mw: p.basis === 'it' ? p.mw * p.pue : p.mw,
    gsl_basin: p.basin === 'gsl',
  };
  out.cooling = kept('cooling') ? atlas.cooling ?? null : ({ dry: 'closed_loop', evap: 'evaporative' })[p.cooling] ?? null;
  if (kept('power')) Object.assign(out, { onsite_gas: atlas.onsite_gas ?? null, power_cooling: atlas.power_cooling ?? null });
  else if (p.power === 'gasTurbine') Object.assign(out, { onsite_gas: true, power_cooling: 'wet' });
  else if (p.power === 'gasRecip') Object.assign(out, { onsite_gas: true, power_cooling: 'dry' });
  else Object.assign(out, { onsite_gas: false, power_cooling: null });
  return out;
}
