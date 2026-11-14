// Environmental Atlas — basin water-risk model, ported from references/utah-water-planner-v3.html.
//
// Score (0–100) = weighted mix of: counted demand vs remaining supply (headroom × dry-year %),
// junior-right share, thin storage buffer, and M&I growth trend. "J" flag: demand exceeds headroom
// and ≥ 50 % of rights are junior, so junior rights would likely be curtailed first.
//
// BASIN BASELINES ARE INVENTED PLACEHOLDERS (public/atlas/data/basin_risk.json) until Division of
// Water Rights / Water Resources data replaces them. The UI must say so wherever a score appears.
//
// Lenses decide what each data center adds to its basin's demand:
//   stated  — developer-published annual use only (most projects publish none: understates)
//   rights  — water rights held or sought (unused rights can be sold or leased)
//   high    — highest figure on record, including independent estimates
//   engine  — impact-engine central estimate for the CURRENT Impact Panel scenario, so legislative
//             levers (closed-loop cooling, dry-cooled power, moratoria…) move the basin scores.
export const LENS_LABELS = {
  engine: 'Engine estimate (current scenario)', stated: 'Developer says', rights: 'Water rights', high: 'Highest on record',
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const nn = (...v) => v.filter((x) => x != null);

export async function loadBasinRisk(url = '/atlas/data/basin_risk.json') {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`basin_risk.json HTTP ${r.status}`);
  return r.json();
}

/**
 * @param data   basin_risk.json
 * @param opts   { lens, dry (0-100 % of normal supply), year, includePaused, engineAF: {engine_id: central AF/yr} }
 */
export function scoreBasins(data, { lens = 'engine', dry = 100, year = 2032, includePaused = false, engineAF = {} } = {}) {
  const weights = Object.fromEntries(data.factors.map((f) => [f.k, f.w]));
  const tw = Object.values(weights).reduce((a, c) => a + c, 0) || 1;
  const cats = data.categories;
  const valueOf = (p) => {
    if (lens === 'stated') return p.stated_af;
    if (lens === 'rights') return p.rights_af;
    if (lens === 'high') { const a = nn(p.stated_af, p.rights_af, p.independent_high_af, p.other_high_af); return a.length ? Math.max(...a) : null; }
    return p.engine_id && p.engine_id in engineAF ? engineAF[p.engine_id] : null;
  };
  return data.basins.map((b) => {
    let projectsAF = 0, unknown = 0;
    const counted = [];
    for (const p of data.projects) {
      if (p.basin !== b.name || p.year > year || (p.status === 'paused' && !includePaused)) continue;
      if (lens === 'engine' && !(p.engine_id && p.engine_id in engineAF)) { if (!p.engine_id) unknown++; continue; }
      const v = valueOf(p);
      if (v == null) unknown++; else { projectsAF += v; counted.push({ name: p.name, af: v, basin_uncertain: p.basin_uncertain }); }
    }
    const demand = b.demand + projectsAF, headroom = (b.headroom * dry) / 100, ratio = headroom > 0 ? demand / headroom : 9;
    const f = { ratio: clamp(ratio / 1.5, 0, 1), junior: clamp(b.junior / 100, 0, 1), storage: 1 - clamp(b.storage / 100, 0, 1), trend: clamp(b.trend / 25, 0, 1) };
    const score = data.factors.reduce((s, x) => s + (weights[x.k] * f[x.k] * 100) / tw, 0);
    const cat = [...cats].reverse().find((c) => score >= c.min) || cats[0];
    return { name: b.name, lon: b.lon, lat: b.lat, score, category: cat.name, color: cat.hex, demand, headroom, ratio,
             projects_af: projectsAF, counted, unknown, junior: b.junior, storage: b.storage, trend: b.trend,
             curtail: demand > headroom && b.junior >= 50 };
  });
}

export function basinRiskGeoJSON(rows) {
  return { type: 'FeatureCollection', features: rows.map((r) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
    properties: { name: r.name, score: r.score, category: r.category, demand: Math.round(r.demand), headroom: Math.round(r.headroom),
                  projects_af: Math.round(r.projects_af), unknown: r.unknown, curtail: r.curtail, placeholder: true } })) };
}

export function pushBasinRisk(map, rows) {
  if (!map) return;
  map.__atlasBasinRisk = basinRiskGeoJSON(rows);    // kept so addAtlasLayers restores it after a style reload
  map.getSource('atlas-basinrisk')?.setData(map.__atlasBasinRisk);
}
