/* Environmental charts: dependency-free SVG charts shared by the homepage and the inversion page.
 *
 *   EnvCharts.pmTrend(el, historyPayload)          hourly PM2.5 + 24-h average over EPA bands
 *   EnvCharts.monitorBars(el, monitors, opts)      ranked latest PM2.5 at every DAQ monitor
 *   EnvCharts.outlook(el, days)                    7-day mixing height + morning warm layer
 *   EnvCharts.profile(el, inversionToday)          temperature vs elevation, lid, trailheads
 *
 * Every chart redraws at its container's real width (text never scales), has a hover and
 * keyboard tooltip, a data-table view, and an honest empty state. Colors that carry meaning
 * (EPA PM2.5 levels, GO/CAUTION/SKIP, Low/Medium/High) always ship with a text label.
 */
(function () {
  // Mark colours (light theme by default). setTheme() swaps them for a dark surface; text colours
  // come from CSS (--ink / --muted on the chart's container).
  let INK = "#172c2d", GRID = "#e4e8e1", AXIS = "#cfd9d4";
  let MOSS = "#28564e", MOSS_DARK = "#123d39", SOFT = "#93b3aa", CORAL = "#c4432f";
  function setTheme(theme = {}) {
    ({ ink: INK = INK, grid: GRID = GRID, axis: AXIS = AXIS, mark: MOSS = MOSS, strong: MOSS_DARK = MOSS_DARK,
      soft: SOFT = SOFT, accent: CORAL = CORAL } = theme);
  }

  // EPA PM2.5 breakpoints (2024). Hourly values are compared against the same breakpoints as
  // an "EPA level"; the official AQI uses the 24-hour average.
  const PM_BANDS = [
    { max: 9, name: "Good", color: "#00b400" },
    { max: 35.4, name: "Moderate", color: "#e6c800" },
    { max: 55.4, name: "Unhealthy for sensitive groups", color: "#ff7e00" },
    { max: 125.4, name: "Unhealthy", color: "#e00000" },
    { max: Infinity, name: "Very unhealthy", color: "#8f3f97" },
  ];
  const VERDICT = { GO: "#14964a", CAUTION: "#c87800", SKIP: "#c83232" };
  const RISK = { Low: "#22a05a", Medium: "#e0a020", High: "#c83232" };
  const TZ = "America/Denver";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const band = (pm) => PM_BANDS.find((b) => pm <= b.max);
  const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(d).replace(/\.0+$/, ""));
  const toF = (c) => c * 9 / 5 + 32;
  const ft = (m) => Math.round(m * 3.281).toLocaleString();
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  function niceMax(v) {
    const steps = [5, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 300, 500, 1000, 1500, 2000, 2500, 3000, 4000];
    return steps.find((s) => s >= v) ?? Math.ceil(v / 1000) * 1000;
  }

  function ticks(lo, hi, n = 4) {
    const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw || 1));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric" });
  const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "numeric", day: "numeric" });
  const hourOf = (d) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(d));

  /* ---------- tooltip (one shared element, fixed-positioned) ---------- */
  let tipEl;
  function tip(html, x, y) {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "env-tip";
      tipEl.setAttribute("role", "status");
      document.body.appendChild(tipEl);
    }
    if (html == null) { tipEl.hidden = true; return; }
    tipEl.innerHTML = html;
    tipEl.hidden = false;
    const r = tipEl.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    tipEl.style.left = `${Math.max(8, left)}px`;
    tipEl.style.top = `${Math.max(8, top)}px`;
  }
  const hideTip = () => tip(null);
  addEventListener("scroll", hideTip, { passive: true });

  /* ---------- scaffolding ---------- */
  function tableHtml(headers, rows) {
    return `<div class="chart-table-wrap"><table><thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function legendHtml(items) {
    return `<div class="chart-legend">${items.map((i) => `<span><i class="key ${i.kind || "box"}" style="--c:${i.color}"></i>${esc(i.label)}</span>`).join("")}</div>`;
  }

  function empty(el, message) {
    if (el._ro) el._ro.disconnect();
    el.innerHTML = `<p class="chart-empty">${esc(message)}</p>`;
  }

  /** Lay out legend + plot + table once, then redraw the plot whenever its width changes. */
  function mount(el, { legend = "", table = "", label, draw }) {
    if (el._ro) el._ro.disconnect();
    el.innerHTML = `${legend}<div class="chart-plot" role="img" aria-label="${esc(label)}"></div>
      ${table ? `<details class="chart-table"><summary>Show the numbers</summary>${table}</details>` : ""}`;
    const plot = el.querySelector(".chart-plot");
    let last = 0;
    const run = () => {
      const w = Math.round(plot.clientWidth);
      if (!w || w === last) return;
      last = w;
      hideTip();
      plot.innerHTML = draw(w);
      if (draw.after) draw.after(plot, w);
    };
    el._ro = new ResizeObserver(run);
    el._ro.observe(plot);
    run();
  }

  const svgOpen = (w, h) => `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">`;

  function yAxis(tks, y, L, R, w, unit = "") {
    return tks.map((t) => `<line x1="${L}" x2="${w - R}" y1="${y(t)}" y2="${y(t)}" stroke="${GRID}"/>
      <text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" class="tick">${t.toLocaleString()}${unit}</text>`).join("");
  }

  /** Hover/keyboard layer: `pick(px, py)` returns {html, x, y} (chart coords) or null; `step(i)` for arrow keys. */
  function interactive(plot, { pick, count, at, onMove }) {
    const svg = plot.querySelector("svg");
    const hit = plot.querySelector(".hit");
    if (!svg || !hit) return;
    let index = -1;
    const show = (res, clientX, clientY) => {
      if (!res) { hideTip(); onMove && onMove(null); return; }
      onMove && onMove(res);
      const box = svg.getBoundingClientRect();
      tip(res.html, clientX ?? box.left + res.x, clientY ?? box.top + res.y);
    };
    hit.addEventListener("pointermove", (ev) => {
      const box = svg.getBoundingClientRect();
      const res = pick(ev.clientX - box.left, ev.clientY - box.top);
      if (res && res.index != null) index = res.index;
      show(res, ev.clientX, ev.clientY);
    });
    hit.addEventListener("pointerleave", () => show(null));
    hit.addEventListener("blur", () => show(null));
    if (count && at) {
      hit.setAttribute("tabindex", "0");
      hit.addEventListener("focus", () => { if (index < 0) index = count - 1; show(at(index)); });
      hit.addEventListener("keydown", (ev) => {
        const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
        if (!delta) return;
        ev.preventDefault();
        index = clamp(index + delta, 0, count - 1);
        show(at(index));
      });
    }
  }

  function linePath(points, x, y, key) {
    let d = "", pen = false;
    for (const p of points) {
      if (p[key] == null) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${x(p).toFixed(1)},${y(p[key]).toFixed(1)}`;
      pen = true;
    }
    return d;
  }

  /* ======================================================================
   * 1. PM2.5 trend: hourly (light) and 24-hour average (strong) over EPA bands
   * ==================================================================== */
  function pmTrend(el, data) {
    const pts = (data?.points || []).map((p) => ({ ...p, time: new Date(p.t) }));
    if (pts.length < 2) return empty(el, "This monitor has not reported enough recent readings to chart.");
    const name = data.station?.name || "this monitor";
    const vals = pts.flatMap((p) => [p.pm25, p.pm25_24h]).filter((v) => v != null);
    const ymax = niceMax(Math.max(12, ...vals) * 1.08);
    const t0 = pts[0].time.getTime(), t1 = pts[pts.length - 1].time.getTime();
    const geom = (w) => {
      const narrow = w < 560;
      const H = w < 360 ? 190 : narrow ? 230 : 290, L = 40, R = narrow ? 14 : 92, T = 12, B = 28;
      const x = (p) => L + (p.time.getTime() - t0) / Math.max(1, t1 - t0) * (w - L - R);
      const y = (v) => T + (1 - clamp(v, 0, ymax) / ymax) * (H - T - B);
      return { narrow, H, L, R, T, B, x, y };
    };
    const draw = (w) => {
      const { narrow, H, L, R, T, B, x, y } = geom(w);

      // EPA bands as a quiet backdrop, labelled where there is room.
      let lo = 0, bands = "";
      for (const b of PM_BANDS) {
        if (lo >= ymax) break;
        const hi = Math.min(b.max, ymax), top = y(hi), bottom = y(lo);
        bands += `<rect x="${L}" y="${top}" width="${w - L - R}" height="${bottom - top}" fill="${b.color}" opacity=".09"/>`;
        if (bottom - top >= 16) bands += `<text x="${L + 6}" y="${top + 13}" class="band-label">${esc(b.name)}</text>`;
        lo = b.max;
      }

      // Day ticks at local midnight (or every 6 h on short ranges).
      const short = t1 - t0 <= 36 * 3600e3;
      const xticks = pts.filter((p) => { const h = hourOf(p.time); return short ? h % 6 === 0 : h === 0; });
      const xLabels = xticks.map((p) => {
        const label = short ? timeFmt.format(p.time) : dayFmt.format(p.time).split(",")[0];
        return `<line x1="${x(p)}" x2="${x(p)}" y1="${T}" y2="${H - B}" stroke="${GRID}"/>
          <text x="${x(p)}" y="${H - B + 17}" text-anchor="middle" class="tick">${esc(label)}</text>`;
      }).join("");

      const last = [...pts].reverse().find((p) => p.pm25_24h != null);
      const lastHour = [...pts].reverse().find((p) => p.pm25 != null);
      const endLabels = narrow ? "" : [
        last && `<text x="${x(last) + 8}" y="${y(last.pm25_24h) + 4}" class="end-label strong">24-h avg ${fmt(last.pm25_24h)}</text>`,
        lastHour && Math.abs(y(lastHour.pm25) - y(last?.pm25_24h ?? -99)) > 14
          && `<text x="${x(lastHour) + 8}" y="${y(lastHour.pm25) + 4}" class="end-label">hourly ${fmt(lastHour.pm25)}</text>`,
      ].filter(Boolean).join("");

      return `${svgOpen(w, H)}${bands}${yAxis(ticks(0, ymax), y, L, R, w)}${xLabels}
        <line x1="${L}" x2="${w - R}" y1="${H - B}" y2="${H - B}" stroke="${AXIS}"/>
        <path d="${linePath(pts, x, y, "pm25")}" fill="none" stroke="${SOFT}" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="${linePath(pts, x, y, "pm25_24h")}" fill="none" stroke="${MOSS_DARK}" stroke-width="2.25" stroke-linejoin="round"/>
        ${last ? `<circle cx="${x(last)}" cy="${y(last.pm25_24h)}" r="4" fill="${MOSS_DARK}" stroke="#fff" stroke-width="2"/>` : ""}
        ${endLabels}
        <g class="hover" visibility="hidden"><line class="guide" y1="${T}" y2="${H - B}" stroke="${INK}" stroke-opacity=".35"/>
          <circle class="d1" r="4" fill="${SOFT}" stroke="#fff" stroke-width="2"/><circle class="d2" r="4.5" fill="${MOSS_DARK}" stroke="#fff" stroke-width="2"/></g>
        <rect class="hit" x="${L}" y="${T}" width="${w - L - R}" height="${H - T - B}" fill="transparent"/></svg>`;
    };
    draw.after = (plot, w) => {
      const { x, y } = geom(w);
      const g = plot.querySelector(".hover");
      const at = (i) => {
        const p = pts[i];
        const lvl = p.pm25_24h != null ? band(p.pm25_24h).name : p.pm25 != null ? band(p.pm25).name : "–";
        return {
          index: i, x: x(p), y: y(p.pm25_24h ?? p.pm25 ?? 0), p,
          html: `<b>${esc(timeFmt.format(p.time))}</b><br>24-h average <b>${fmt(p.pm25_24h)}</b> µg/m³<br>Hourly ${fmt(p.pm25)} µg/m³<br><span class="tip-muted">EPA level: ${esc(lvl)}</span>`,
        };
      };
      interactive(plot, {
        count: pts.length, at,
        pick: (px) => {
          let best = 0, dist = Infinity;
          pts.forEach((p, i) => { const d = Math.abs(x(p) - px); if (d < dist) { dist = d; best = i; } });
          return at(best);
        },
        onMove: (res) => {
          if (!res) { g.setAttribute("visibility", "hidden"); return; }
          const { p } = res;
          g.setAttribute("visibility", "visible");
          g.querySelector(".guide").setAttribute("x1", x(p)); g.querySelector(".guide").setAttribute("x2", x(p));
          const place = (sel, v) => { const c = g.querySelector(sel); c.setAttribute("visibility", v == null ? "hidden" : "visible"); if (v != null) { c.setAttribute("cx", x(p)); c.setAttribute("cy", y(v)); } };
          place(".d1", p.pm25); place(".d2", p.pm25_24h);
        },
      });
    };
    mount(el, {
      label: `PM2.5 at ${name}: hourly readings and 24-hour average over the last ${data.hours} hours`,
      legend: legendHtml([
        { label: "24-hour average (what the AQI uses)", color: MOSS_DARK, kind: "line" },
        { label: "Hourly reading", color: SOFT, kind: "line thin" },
      ]),
      table: tableHtml(["Time", "24-h average (µg/m³)", "Hourly (µg/m³)"],
        pts.slice().reverse().map((p) => [timeFmt.format(p.time), fmt(p.pm25_24h), fmt(p.pm25)])),
      draw,
    });
  }

  /* ======================================================================
   * 2. Ranked latest PM2.5 at every monitor, colored by EPA level
   * ==================================================================== */
  function monitorBars(el, monitors, { highlight = () => false } = {}) {
    const rows = (monitors || []).filter((m) => m.pm25 != null).sort((a, b) => b.pm25 - a.pm25);
    if (!rows.length) return empty(el, "The Utah DAQ monitor feed is unavailable right now. Check air.utah.gov.");
    const ROW = 24, T = 26, B = 22;
    const xmax = niceMax(Math.max(12, ...rows.map((r) => r.pm25)) * 1.15);
    const geom = (w) => {
      const labelW = clamp(Math.round(w * 0.36), 96, 160), L = labelW + 8, R = 40;
      return { L, R, x: (v) => L + clamp(v, 0, xmax) / xmax * (w - L - R), H: T + rows.length * ROW + B };
    };
    const draw = (w) => {
      const { L, R, x, H } = geom(w);
      const refs = [[9, "Good ≤ 9"], [35.4, "Moderate ≤ 35.4"]].filter(([v]) => v <= xmax).map(([v, label]) => `
        <line x1="${x(v)}" x2="${x(v)}" y1="${T - 6}" y2="${H - B}" stroke="${INK}" stroke-opacity=".45" stroke-dasharray="3 3"/>
        <text x="${x(v)}" y="${T - 10}" text-anchor="middle" class="tick">${label}</text>`).join("");
      const bars = rows.map((r, i) => {
        const cy = T + i * ROW + ROW / 2, b = band(r.pm25), mine = highlight(r);
        const end = Math.max(x(r.pm25), L + 4);
        return `<text x="${L - 8}" y="${cy + 4}" text-anchor="end" class="row-label${mine ? " strong" : ""}">${mine ? "● " : ""}${esc(r.name)}</text>
          <path d="M${L},${cy - 6}H${end - 4}a4,4 0 0 1 4,4v4a4,4 0 0 1 -4,4H${L}Z" fill="${b.color}"/>
          <text x="${end + 6}" y="${cy + 4}" class="value">${fmt(r.pm25)}</text>`;
      }).join("");
      const xt = ticks(0, xmax, 4).map((t) => `<text x="${x(t)}" y="${H - 6}" text-anchor="middle" class="tick">${t}</text>`).join("");
      return `${svgOpen(w, H)}<line x1="${L}" x2="${L}" y1="${T - 4}" y2="${H - B}" stroke="${AXIS}"/>${refs}${bars}${xt}
        <rect class="hit" x="0" y="${T}" width="${w}" height="${rows.length * ROW}" fill="transparent"/></svg>`;
    };
    draw.after = (plot, w) => {
      const { x } = geom(w);
      const at = (i) => {
        const r = rows[i];
        return { index: i, x: x(r.pm25), y: T + i * ROW + ROW / 2,
          html: `<b>${esc(r.name)}</b><br>PM2.5 <b>${fmt(r.pm25)}</b> µg/m³<br><span class="tip-muted">EPA level: ${esc(band(r.pm25).name)}</span>` };
      };
      interactive(plot, { count: rows.length, at, pick: (_, py) => at(clamp(Math.floor((py - T) / ROW), 0, rows.length - 1)) });
    };
    const used = PM_BANDS.filter((b) => rows.some((r) => band(r.pm25) === b));
    mount(el, {
      label: `Latest hourly PM2.5 at ${rows.length} Utah air monitors, highest first`,
      legend: legendHtml(used.map((b) => ({ label: b.name, color: b.color }))),
      table: tableHtml(["Monitor", "PM2.5 (µg/m³)", "EPA level"], rows.map((r) => [r.name, fmt(r.pm25), band(r.pm25).name])),
      draw,
    });
  }

  /* ======================================================================
   * 3. Seven-day outlook: afternoon mixing height + morning warm layer (two panels, two axes)
   * ==================================================================== */
  function outlook(el, days) {
    if (!days?.length) return empty(el, "The inversion forecast is unavailable right now.");
    const label = (d) => dayFmt.format(new Date(`${d.date}T12:00:00-07:00`));
    const geom = (w) => {
      const L = 44, R = 10, T = 22, H1 = 170, GAP = 74, H2 = 74, B = 6;
      const n = days.length, slot = (w - L - R) / n, bw = Math.min(46, slot * 0.56);
      const cx = (i) => L + slot * (i + 0.5);
      const mmax = niceMax(Math.max(1200, ...days.map((d) => d.afternoon_mixing_m)) * 1.05);
      const ym = (v) => T + (1 - clamp(v, 0, mmax) / mmax) * H1;
      const inv = days.map((d) => d.morning_inversion_c);
      const lo = Math.min(-1, ...inv) - 0.5, hi = Math.max(3, ...inv) + 0.5;
      const top2 = T + H1 + GAP;
      const yi = (v) => top2 + (1 - (v - lo) / (hi - lo)) * H2;
      return { L, R, T, H1, GAP, H2, B, slot, bw, cx, mmax, ym, lo, hi, top2, yi, H: top2 + H2 + B };
    };
    const bar = (x, y0, y1, w, color, opacity) => {
      const top = Math.min(y0, y1), h = Math.abs(y1 - y0), r = Math.min(4, h / 2), up = y1 < y0;
      return up
        ? `<path d="M${x - w / 2},${y0}V${top + r}a${r},${r} 0 0 1 ${r},${-r}H${x + w / 2 - r}a${r},${r} 0 0 1 ${r},${r}V${y0}Z" fill="${color}" opacity="${opacity}"/>`
        : `<path d="M${x - w / 2},${y0}V${top + h - r}a${r},${r} 0 0 0 ${r},${r}H${x + w / 2 - r}a${r},${r} 0 0 0 ${r},${-r}V${y0}Z" fill="${color}" opacity="${opacity}"/>`;
    };
    const draw = (w) => {
      const g = geom(w);
      const narrow = w < 520;
      const split = days.findIndex((d) => d.confidence === "trend");
      const sepX = split > 0 ? g.L + g.slot * split : null;
      let s = `${svgOpen(w, g.H)}`;
      s += `<text x="${g.L}" y="12" class="panel-title">Afternoon mixing height (m above the valley floor)</text>`;
      s += yAxis(ticks(0, g.mmax, 3), g.ym, g.L, g.R, w);
      s += [[600, "600 m"], [800, "800 m"]].map(([v, t]) => `<line x1="${g.L}" x2="${w - g.R}" y1="${g.ym(v)}" y2="${g.ym(v)}" stroke="${INK}" stroke-opacity=".4" stroke-dasharray="3 3"/>
        ${narrow ? "" : `<text x="${w - g.R}" y="${g.ym(v) - 4}" text-anchor="end" class="tick">${t}${v === 600 ? " · trapped below" : ""}</text>`}`).join("");
      if (sepX) {
        s += `<line x1="${sepX}" x2="${sepX}" y1="${g.T - 4}" y2="${g.top2 + g.H2}" stroke="${AXIS}"/>
          <text x="${sepX - 6}" y="${g.T + 10}" text-anchor="end" class="tick">forecast</text>
          <text x="${sepX + 6}" y="${g.T + 10}" class="tick">trend only</text>`;
      }
      days.forEach((d, i) => {
        const op = d.confidence === "trend" ? 0.5 : 1;
        s += bar(g.cx(i), g.ym(0), g.ym(d.afternoon_mixing_m), g.bw, RISK[d.risk] || SOFT, op);
        const lab = label(d).split(", ");
        s += `<text x="${g.cx(i)}" y="${g.T + g.H1 + 16}" text-anchor="middle" class="tick strong">${esc(lab[0])}</text>
          <text x="${g.cx(i)}" y="${g.T + g.H1 + 31}" text-anchor="middle" class="risk-label">${esc(d.risk)}</text>`;
      });
      s += `<line x1="${g.L}" x2="${w - g.R}" y1="${g.ym(0)}" y2="${g.ym(0)}" stroke="${AXIS}"/>`;
      // panel 2: morning warm layer
      s += `<text x="${g.L}" y="${g.top2 - 8}" class="panel-title">Morning warm layer aloft (°C warmer than the ground)</text>`;
      s += `<line x1="${g.L}" x2="${w - g.R}" y1="${g.yi(0)}" y2="${g.yi(0)}" stroke="${AXIS}"/>
        <line x1="${g.L}" x2="${w - g.R}" y1="${g.yi(2)}" y2="${g.yi(2)}" stroke="${INK}" stroke-opacity=".4" stroke-dasharray="3 3"/>
        <text x="${g.L - 6}" y="${g.yi(0) + 4}" text-anchor="end" class="tick">0</text>
        <text x="${g.L - 6}" y="${g.yi(2) + 4}" text-anchor="end" class="tick">+2</text>`;
      days.forEach((d, i) => {
        const op = d.confidence === "trend" ? 0.5 : 1, v = d.morning_inversion_c;
        s += bar(g.cx(i), g.yi(0), g.yi(v), g.bw * 0.7, v >= 2 ? MOSS_DARK : SOFT, op);
      });
      s += `<rect class="hit" x="${g.L}" y="0" width="${w - g.L - g.R}" height="${g.H}" fill="transparent"/></svg>`;
      return s;
    };
    draw.after = (plot, w) => {
      const g = geom(w);
      const at = (i) => {
        const d = days[i];
        return { index: i, x: g.cx(i), y: g.ym(d.afternoon_mixing_m),
          html: `<b>${esc(label(d))}</b> · ${esc(d.risk)} risk${d.confidence === "trend" ? " (trend only)" : ""}<br>
            Afternoon mixing ≈ <b>${d.afternoon_mixing_m.toLocaleString()} m</b><br>
            Lid ≈ ${d.lid_elevation_m.toLocaleString()} m (${ft(d.lid_elevation_m)} ft) elevation<br>
            Morning warm layer ${d.morning_inversion_c > 0 ? "+" : ""}${fmt(d.morning_inversion_c)} °C` };
      };
      interactive(plot, { count: days.length, at, pick: (px) => at(clamp(Math.floor((px - g.L) / g.slot), 0, days.length - 1)) });
    };
    mount(el, {
      label: "Seven-day inversion outlook: afternoon mixing height and morning warm layer per day",
      legend: legendHtml([
        { label: "Low risk", color: RISK.Low }, { label: "Medium risk", color: RISK.Medium }, { label: "High risk", color: RISK.High },
        { label: "Warm layer ≥ 2 °C (inversion)", color: MOSS_DARK },
      ]),
      table: tableHtml(["Day", "Risk", "Afternoon mixing (m)", "Lid elevation (m)", "Morning warm layer (°C)", "Confidence"],
        days.map((d) => [label(d), d.risk, d.afternoon_mixing_m, d.lid_elevation_m, fmt(d.morning_inversion_c), d.confidence])),
      draw,
    });
  }

  /* ======================================================================
   * 4. Temperature vs elevation: station readings, median profile, lid, trailhead rail
   * ==================================================================== */
  function profile(el, d) {
    const stations = (d?.stations || []).filter((s) => s.air_temp_c != null && s.elevation_m != null);
    if (stations.length < 3) return empty(el, "Too few weather stations reported near this starting point to draw a temperature profile.");
    const lid = d.lid?.has_inversion ? d.lid.lid_m : null;
    const sorted = [...stations].sort((a, b) => a.elevation_m - b.elevation_m);
    const trail = (d.trailheads || []).filter((t) => t.elevation_m != null);
    // Median temperature per 100 m band: the same profile the lid estimate reads.
    const bins = {};
    stations.forEach((s) => { (bins[Math.floor(s.elevation_m / 100)] ||= []).push(s.air_temp_c); });
    const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const prof = Object.entries(bins).map(([b, v]) => ({ e: Number(b) * 100 + 50, t: median(v) })).sort((a, b) => a.e - b.e);

    const geom = (w) => {
      const narrow = w < 560;
      const L = 52, RAIL = trail.length ? (narrow ? 64 : 92) : 0, R = 12 + RAIL, T = 16, B = 34;
      const H = narrow ? 320 : 380;
      const temps = stations.map((s) => toF(s.air_temp_c));
      const tlo = Math.floor(Math.min(...temps) - 2), thi = Math.ceil(Math.max(...temps) + 2);
      const elevs = [...stations.map((s) => s.elevation_m), ...trail.map((t) => t.elevation_m), lid ?? 0].filter(Boolean);
      const elo = Math.floor((Math.min(...elevs) - 60) / 100) * 100, ehi = Math.ceil((Math.max(...elevs) + 60) / 100) * 100;
      const x = (tf) => L + (tf - tlo) / (thi - tlo) * (w - L - R);
      const y = (e) => T + (1 - (e - elo) / (ehi - elo)) * (H - T - B);
      return { narrow, L, R, RAIL, T, B, H, tlo, thi, elo, ehi, x, y };
    };
    const draw = (w) => {
      const g = geom(w);
      let s = svgOpen(w, g.H);
      if (lid) {
        s += `<rect x="${g.L}" y="${g.y(lid)}" width="${w - g.L - g.R}" height="${g.y(g.elo) - g.y(lid)}" fill="${CORAL}" opacity=".07"/>`;
      }
      s += yAxis(ticks(g.elo, g.ehi, 5), g.y, g.L, g.R, w);
      s += ticks(g.tlo, g.thi, 5).map((t) => `<text x="${g.x(t)}" y="${g.H - g.B + 17}" text-anchor="middle" class="tick">${t}°</text>`).join("");
      s += `<line x1="${g.L}" x2="${w - g.R}" y1="${g.H - g.B}" y2="${g.H - g.B}" stroke="${AXIS}"/>
        <text x="${(g.L + w - g.R) / 2}" y="${g.H - 4}" text-anchor="middle" class="axis-title">Air temperature (°F) → warmer</text>
        <text x="12" y="${(g.T + g.H - g.B) / 2}" transform="rotate(-90 12 ${(g.T + g.H - g.B) / 2})" text-anchor="middle" class="axis-title">Elevation (m)</text>`;
      s += stations.map((st) => `<circle cx="${g.x(toF(st.air_temp_c))}" cy="${g.y(st.elevation_m)}" r="4" fill="${MOSS}" fill-opacity=".55" stroke="#fff" stroke-width="1.5"/>`).join("");
      s += `<polyline points="${prof.map((p) => `${g.x(toF(p.t)).toFixed(1)},${g.y(p.e).toFixed(1)}`).join(" ")}" fill="none" stroke="${MOSS_DARK}" stroke-width="2.25" stroke-linejoin="round"/>`;
      if (lid) {
        s += `<line x1="${g.L}" x2="${w - g.R + g.RAIL}" y1="${g.y(lid)}" y2="${g.y(lid)}" stroke="${CORAL}" stroke-width="2"/>
          <text x="${g.L + 8}" y="${g.y(lid) - 7}" class="lid-label">Smog lid ≈ ${lid.toLocaleString()} m (${ft(lid)} ft)</text>
          <text x="${g.L + 8}" y="${g.y(lid) + 16}" class="tick">pollution trapped below</text>`;
      } else {
        s += `<text x="${w - g.R - 8}" y="${g.T + 14}" text-anchor="end" class="tick strong">No warm layer: air cools with height, so it can mix</text>`;
      }
      if (g.RAIL) {
        const rx = w - g.RAIL + 18, rw = g.narrow ? 22 : 28;
        s += `<text x="${rx + rw / 2}" y="${g.T - 4}" text-anchor="middle" class="tick strong">Trailheads</text>
          <line x1="${rx + rw / 2}" x2="${rx + rw / 2}" y1="${g.T + 4}" y2="${g.H - g.B}" stroke="${GRID}"/>`;
        s += trail.map((t) => `<line x1="${rx}" x2="${rx + rw}" y1="${g.y(t.elevation_m)}" y2="${g.y(t.elevation_m)}" stroke="${VERDICT[t.verdict] || SOFT}" stroke-width="2" stroke-opacity=".85"/>`).join("");
        if (!g.narrow) {
          const counts = ["GO", "CAUTION", "SKIP"].map((v) => [v, trail.filter((t) => t.verdict === v).length]).filter(([, n]) => n);
          s += counts.map(([v, n], i) => `<text x="${rx + rw + 6}" y="${g.H - g.B - 6 - i * 14}" class="tick">${n} ${v}</text>`).join("");
        }
      }
      s += `<rect class="hit" x="${g.L}" y="${g.T}" width="${w - g.L - 12}" height="${g.H - g.T - g.B}" fill="transparent"/></svg>`;
      return s;
    };
    draw.after = (plot, w) => {
      const g = geom(w);
      const railX = w - g.RAIL;
      const stationTip = (st, i) => ({ index: i, x: g.x(toF(st.air_temp_c)), y: g.y(st.elevation_m),
        html: `<b>${esc(st.name)}</b><br>${Math.round(st.elevation_m).toLocaleString()} m (${ft(st.elevation_m)} ft)<br>${fmt(toF(st.air_temp_c))} °F · ${fmt(st.air_temp_c)} °C` });
      interactive(plot, {
        count: sorted.length,
        at: (i) => stationTip(sorted[i], i),
        pick: (px, py) => {
          if (g.RAIL && px >= railX) {
            let best = null, dist = Infinity;
            trail.forEach((t) => { const dd = Math.abs(g.y(t.elevation_m) - py); if (dd < dist) { dist = dd; best = t; } });
            if (!best || dist > 12) return null;
            return { x: px, y: g.y(best.elevation_m),
              html: `<b>${esc(best.name)}</b> · ${esc(best.verdict)}<br>${Math.round(best.elevation_m).toLocaleString()} m · ${best.distance_km} km away<br><span class="tip-muted">${esc(best.why)}</span>` };
          }
          let best = -1, dist = Infinity;
          sorted.forEach((st, i) => { const dd = Math.hypot(g.x(toF(st.air_temp_c)) - px, g.y(st.elevation_m) - py); if (dd < dist) { dist = dd; best = i; } });
          return dist <= 28 ? stationTip(sorted[best], best) : null;
        },
      });
    };
    const legend = [
      { label: "Weather station reading", color: MOSS, kind: "dot" },
      { label: "Median by 100 m of elevation", color: MOSS_DARK, kind: "line" },
      ...(lid ? [{ label: "Estimated smog lid", color: CORAL, kind: "line" }] : []),
      ...(trail.length ? [{ label: "Trailhead: GO", color: VERDICT.GO, kind: "line" }, { label: "CAUTION", color: VERDICT.CAUTION, kind: "line" }, { label: "SKIP", color: VERDICT.SKIP, kind: "line" }] : []),
    ];
    mount(el, {
      label: `Air temperature against elevation at ${stations.length} weather stations${lid ? `, with an estimated smog lid near ${lid} metres` : ", with no inversion detected"}`,
      legend: legendHtml(legend),
      table: tableHtml(["Station", "Elevation (m)", "Temperature (°F)", "Temperature (°C)"],
        sorted.map((st) => [st.name, Math.round(st.elevation_m), fmt(toF(st.air_temp_c)), fmt(st.air_temp_c)])),
      draw,
    });
  }

  window.EnvCharts = { pmTrend, monitorBars, outlook, profile, setTheme, PM_BANDS, band };
})();
