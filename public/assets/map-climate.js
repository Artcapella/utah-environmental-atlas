/* Climate overlays for the map (public/map.html), driven by the map's own time slider.
 *
 *   Fields (one at a time, statewide, clipped to Utah): modeled PM2.5, temperature, mixing height
 *   Wind arrows on top of any field
 *   Live NWS alerts (replaces the demo polygons in DATA.alerts)
 *   A 48-hour PM2.5 trend chart in an air monitor's detail panel
 *
 * Data: /api/climate/grid (Open-Meteo, 72 h in 3 h steps, interpolated here), /api/alerts,
 * /api/air/history. Everything plugs in through window.YOUtah (addLayer / onTime / onDetail).
 */
(function () {
  "use strict";
  const hub = window.YOUtah;
  if (!hub) return;

  const UTAH = { w: -114.05, s: 37.0, e: -109.05, n: 42.0, notchLon: -111.05, notchLat: 41.0 };
  const IMG = 384;                       // canvas size for a field image
  const REFRESH_MS = 60 * 60 * 1000;

  /* ---------- colour ramps (value -> [r,g,b,a]) ---------- */
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const FIELDS = {
    "f-pm": {
      key: "pm25", unit: "µg/m³", digits: 1, name: "Air quality (PM2.5)", short: "PM2.5",
      stops: [[0, "#1f9e5a"], [9, "#9ccc4e"], [20, "#f2d43d"], [35.4, "#f28c28"], [55.4, "#d7301f"], [150, "#7a1f6b"]],
      alpha: (v) => (v <= 9 ? lerp(v, 0, 9, 0.34, 0.44) : lerp(v, 9, 55.4, 0.5, 0.72)), ticks: [0, 9, 35, 55], tickLabel: (v) => (v === 55 ? "55+" : String(v)),
      note: "Modeled fine particles (Copernicus CAMS via Open-Meteo), about 40 km detail. EPA levels: Good ≤ 9, Moderate ≤ 35.",
      describe: (v) => `${fmt(v, 1)} µg/m³ (${pmLevel(v)})`,
    },
    "f-temp": {
      key: "temp_f", unit: "°F", digits: 0, name: "Temperature", short: "Temp",
      stops: [[-10, "#3b2a8f"], [10, "#2f6db5"], [32, "#8fc3e6"], [45, "#eef1d6"], [60, "#f5c26b"], [75, "#e2702f"], [100, "#a3271c"]],
      alpha: () => 0.55, ticks: [0, 32, 60, 90], tickLabel: (v) => `${v}°`,
      note: "2 m air temperature forecast (Open-Meteo). Cold pools in the valleys under warmer slopes are inversion weather.",
      describe: (v) => `${fmt(v, 0)} °F`,
    },
    "f-mix": {
      key: "mix_m", unit: "m", digits: 0, name: "Mixing height (inversion risk)", short: "Mixing",
      stops: [[0, "#4a1f5c"], [300, "#7d3f86"], [600, "#b77fb0"], [1000, "#e8d6df"], [2500, "#eef3ee"]],
      alpha: (v) => lerp(v, 500, 1600, 0.68, 0.12), ticks: [0, 300, 600, 1000, 2000], tickLabel: (v) => (v >= 1000 ? `${v / 1000}k` : String(v)),
      note: "How deep the air can mix (m above ground). Below ~600 m, pollution is trapped near the valley floor.",
      describe: (v) => `${Math.round(v).toLocaleString()} m mixing${v < 600 ? " (trapped)" : ""}`,
    },
  };
  const FIELD_IDS = Object.keys(FIELDS);

  const fmt = (v, d) => (v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(d));
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const lerp = (x, x0, x1, y0, y1) => y0 + (y1 - y0) * clamp((x - x0) / (x1 - x0), 0, 1);
  const pmLevel = (v) => (v <= 9 ? "Good" : v <= 35.4 ? "Moderate" : v <= 55.4 ? "Unhealthy for sensitive groups" : "Unhealthy");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const getJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url} ${r.status}`))));

  function rampColor(field, v) {
    const stops = field.stops;
    if (v <= stops[0][0]) return [...hex(stops[0][1]), field.alpha(v)];
    for (let i = 1; i < stops.length; i++) {
      if (v <= stops[i][0] || i === stops.length - 1) {
        const [x0, c0] = stops[i - 1], [x1, c1] = stops[i], a = hex(c0), b = hex(c1);
        return [0, 1, 2].map((k) => lerp(v, x0, x1, a[k], b[k])).concat(field.alpha(v));
      }
    }
    return [0, 0, 0, 0];
  }
  const rampCss = (field) => {
    const lo = field.stops[0][0], hi = field.stops[field.stops.length - 1][0];
    return `linear-gradient(90deg, ${field.stops.map(([v, c]) => `${c} ${((v - lo) / (hi - lo) * 100).toFixed(1)}%`).join(", ")})`;
  };

  /* ---------- grid sampling in space and time ---------- */
  const state = { grid: null, active: null, alertsLoaded: false, alertCount: 0 };

  /** Bilinear in space, linear in time: `rows` is [step][point], `s` a fractional step. */
  function sampleRows(rows, s, lon, lat) {
    const g = state.grid;
    if (!rows || !g?.lons?.length) return null;
    const nx = g.lons.length, ny = g.lats.length;
    const fx = (lon - g.lons[0]) / (g.lons[nx - 1] - g.lons[0]) * (nx - 1);
    const fy = (lat - g.lats[0]) / (g.lats[ny - 1] - g.lats[0]) * (ny - 1);
    if (fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) return null;
    const s0 = Math.floor(s), s1 = Math.min(s0 + 1, rows.length - 1), st = s - s0;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, nx - 1), y1 = Math.min(y0 + 1, ny - 1), tx = fx - x0, ty = fy - y0;
    const bil = (row) => {
      const v = [row[y0 * nx + x0], row[y0 * nx + x1], row[y1 * nx + x0], row[y1 * nx + x1]];
      if (v.some((x) => x == null)) return v.find((x) => x != null) ?? null;
      return (v[0] * (1 - tx) + v[1] * tx) * (1 - ty) + (v[2] * (1 - tx) + v[3] * tx) * ty;
    };
    const a = bil(rows[s0]), b = bil(rows[s1]);
    if (a == null || b == null) return a ?? b;
    return a + (b - a) * st;
  }
  const sample = (key, s, lon, lat) => sampleRows(state.grid?.fields?.[key], s, lon, lat);

  /** Fractional step index for the map's selected time. */
  function stepAt() {
    const g = state.grid;
    if (!g) return 0;
    const T = hub.tAt().getTime(), t0 = Date.parse(g.times[0]), dt = Date.parse(g.times[1]) - t0;
    return clamp((T - t0) / dt, 0, g.times.length - 1);
  }

  /** Wind from u/v components (interpolating the angle itself would break across north). */
  function windAt(s, lon, lat) {
    const f = state.grid?.fields;
    if (!f?.wind_mph || !f.wind_dir) return null;
    if (!state.uv) {
      const u = [], v = [];
      f.wind_mph.forEach((row, k) => {
        u.push(row.map((sp, i) => (sp == null || f.wind_dir[k][i] == null ? null : -sp * Math.sin(f.wind_dir[k][i] * Math.PI / 180))));
        v.push(row.map((sp, i) => (sp == null || f.wind_dir[k][i] == null ? null : -sp * Math.cos(f.wind_dir[k][i] * Math.PI / 180))));
      });
      state.uv = { u, v };
    }
    const uu = sampleRows(state.uv.u, s, lon, lat), vv = sampleRows(state.uv.v, s, lon, lat);
    if (uu == null || vv == null) return null;
    return { speed: Math.hypot(uu, vv), from: (Math.atan2(-uu, -vv) * 180 / Math.PI + 360) % 360 };
  }

  /* ---------- field image (Mercator-correct rows, clipped to Utah) ---------- */
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const invMercY = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
  const inUtah = (lon, lat) => lon >= UTAH.w && lon <= UTAH.e && lat >= UTAH.s && lat <= UTAH.n && !(lon > UTAH.notchLon && lat > UTAH.notchLat);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = IMG;

  function fieldImage(id) {
    const field = FIELDS[id], s = stepAt();
    const ctx = canvas.getContext("2d"), img = ctx.createImageData(IMG, IMG);
    const yTop = mercY(UTAH.n), yBot = mercY(UTAH.s);
    for (let py = 0; py < IMG; py++) {
      const lat = invMercY(yTop + (yBot - yTop) * (py + 0.5) / IMG);
      for (let px = 0; px < IMG; px++) {
        const lon = UTAH.w + (UTAH.e - UTAH.w) * (px + 0.5) / IMG;
        if (!inUtah(lon, lat)) continue;
        const v = sample(field.key, s, lon, lat);
        if (v == null) continue;
        const [r, g, b, a] = rampColor(field, v);
        img.data.set([r, g, b, Math.round(a * 255)], (py * IMG + px) * 4);
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL();
  }

  const CORNERS = [[UTAH.w, UTAH.n], [UTAH.e, UTAH.n], [UTAH.e, UTAH.s], [UTAH.w, UTAH.s]];

  function drawField() {
    const map = hub.map;
    if (!map || !hub.mapReady) return;
    const id = state.active;
    if (!id || !state.grid?.fields?.[FIELDS[id].key]) {
      if (map.getLayer("climate-field")) map.setLayoutProperty("climate-field", "visibility", "none");
      return;
    }
    const url = fieldImage(id);
    if (map.getSource("climate-field")) map.getSource("climate-field").updateImage({ url, coordinates: CORNERS });
    else map.addSource("climate-field", { type: "image", url, coordinates: CORNERS });
    if (!map.getLayer("climate-field")) {
      map.addLayer({ id: "climate-field", type: "raster", source: "climate-field",
        paint: { "raster-opacity": 1, "raster-fade-duration": 0, "raster-resampling": "linear" } }, "slot-fill");
    }
    map.setLayoutProperty("climate-field", "visibility", "visible");
  }

  /* ---------- wind arrows ---------- */
  function arrowImage() {
    const s = 48, c = document.createElement("canvas");
    c.width = c.height = s;
    const g = c.getContext("2d");
    g.translate(s / 2, s / 2);
    g.beginPath();
    g.moveTo(0, -19); g.lineTo(9, -4); g.lineTo(3, -5); g.lineTo(3, 18); g.lineTo(-3, 18); g.lineTo(-3, -5); g.lineTo(-9, -4); g.closePath();
    g.fillStyle = "#ffffff"; g.strokeStyle = "rgba(15,38,40,.85)"; g.lineWidth = 2.5;
    g.stroke(); g.fill();
    return g.getImageData(0, 0, s, s);
  }

  function windFeatures() {
    const g = state.grid;
    if (!g?.fields?.wind_mph) return [];
    const s = stepAt(), out = [];
    for (let i = 0; i < g.lats.length; i++) {
      for (let j = 0; j < g.lons.length; j++) {
        const lat = g.lats[i], lon = g.lons[j];
        if (!inUtah(lon, lat)) continue;
        const w = windAt(s, lon, lat);
        if (!w) continue;
        out.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] },
          properties: { rot: (w.from + 180) % 360, spd: Math.round(w.speed) } });
      }
    }
    return out;
  }

  function drawWind(on) {
    const map = hub.map;
    if (!map || !hub.mapReady) return;
    if (!map.hasImage("wind-arrow")) map.addImage("wind-arrow", arrowImage(), { pixelRatio: 2 });
    const data = { type: "FeatureCollection", features: on ? windFeatures() : [] };
    if (map.getSource("climate-wind")) map.getSource("climate-wind").setData(data);
    else map.addSource("climate-wind", { type: "geojson", data });
    if (!map.getLayer("climate-wind")) {
      map.addLayer({ id: "climate-wind", type: "symbol", source: "climate-wind", layout: {
        "icon-image": "wind-arrow", "icon-rotate": ["get", "rot"], "icon-rotation-alignment": "map", "icon-allow-overlap": true,
        "icon-size": ["interpolate", ["linear"], ["get", "spd"], 0, 0.75, 10, 1.05, 25, 1.5],
      }, paint: { "icon-opacity": ["interpolate", ["linear"], ["get", "spd"], 0, 0.35, 4, 0.9] } }, "slot-heat");
    }
    map.setLayoutProperty("climate-wind", "visibility", on ? "visible" : "none");
  }

  /* ---------- layer registration ---------- */
  const SRC = hub.SOURCES;
  SRC.cams = { name: "Open-Meteo air quality (Copernicus CAMS model)", url: "https://open-meteo.com/en/docs/air-quality-api" };
  SRC.openmeteo = { name: "Open-Meteo forecast (NOAA HRRR/GFS and others)", url: "https://open-meteo.com/" };

  function fieldLegend(id) {
    return () => `<span class="ll-ramp" style="background:${rampCss(FIELDS[id])}"></span><span class="fine">${esc(FIELDS[id].note)}</span>`;
  }

  function applyField(id, on) {
    if (on) {
      state.active = id;
      for (const other of FIELD_IDS) if (other !== id && hub.state.layers.has(other)) hub.setLayer(other, false);
    } else if (state.active === id) {
      state.active = FIELD_IDS.find((f) => hub.state.layers.has(f)) || null;
    }
    drawField();
  }

  hub.addLayer({ id: "f-pm", after: "inversion", cat: "conditions", name: "Air quality field (PM2.5 forecast, statewide)", emoji: "🟢", color: "#9ccc4e",
    src: "cams", on: true, apply: (on) => applyField("f-pm", on), legend: fieldLegend("f-pm") });
  hub.addLayer({ id: "f-temp", after: "f-pm", cat: "conditions", name: "Temperature field (statewide)", emoji: "🌡", color: "#e2702f",
    src: "openmeteo", apply: (on) => applyField("f-temp", on), legend: fieldLegend("f-temp") });
  hub.addLayer({ id: "f-mix", after: "f-temp", cat: "conditions", name: "Mixing height (inversion risk)", emoji: "🫧", color: "#b77fb0",
    src: "openmeteo", apply: (on) => applyField("f-mix", on), legend: fieldLegend("f-mix") });
  hub.addLayer({ id: "f-wind", after: "f-mix", cat: "conditions", name: "Wind arrows", emoji: "🧭", color: "#6fa8bf",
    src: "openmeteo", on: true, apply: (on) => drawWind(on),
    legend: () => `<span class="fine">Arrows point where the air is going; bigger = stronger. Calm air lets smog build.</span>` });

  /* ---------- station temperatures vs the nearby valley floor (inversion signature) ---------- */
  const TEMP_STOPS = [-6, "#2f6db5", -2, "#93b4d8", 0, "#cfd5d2", 2, "#f0a07a", 6, "#c4432f"];
  function anomalyFeatures() {
    const st = (hub.DATA.wx || []).filter((w) => w.live && w.temp != null && w.elev != null);
    const near = (a, b) => Math.abs(a.lat - b.lat) < 0.4 && Math.abs(a.lng - b.lng) < 0.5; // ~40 km
    return st.map((w) => {
      const hood = st.filter((o) => near(o, w));
      const floor = Math.min(...hood.map((o) => o.elev));
      const base = hood.filter((o) => o.elev < floor + 120).map((o) => o.temp).sort((a, b) => a - b);
      const ref = base[base.length >> 1];
      return { type: "Feature", geometry: { type: "Point", coordinates: [w.lng, w.lat] },
        properties: { anom_c: +(w.temp - ref).toFixed(1), gid: w.gid } };
    });
  }
  let lastWx = null;
  function drawAnomaly(on) {
    const map = hub.map;
    if (!map || !hub.mapReady) return;
    const data = { type: "FeatureCollection", features: on ? anomalyFeatures() : [] };
    lastWx = hub.DATA.wx;
    if (map.getSource("climate-anom")) map.getSource("climate-anom").setData(data);
    else map.addSource("climate-anom", { type: "geojson", data });
    if (!map.getLayer("climate-anom")) {
      map.addLayer({ id: "climate-anom", type: "circle", source: "climate-anom", paint: {
        "circle-color": ["interpolate", ["linear"], ["get", "anom_c"], ...TEMP_STOPS],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 4, 12, 8],
        "circle-stroke-color": "#0f2628", "circle-stroke-width": 1.2 } }, "slot-heat");
    }
    map.setLayoutProperty("climate-anom", "visibility", on ? "visible" : "none");
  }
  hub.addLayer({ id: "f-anom", after: "f-wind", cat: "conditions", name: "Inversion: stations warmer than the valley", emoji: "🌡", color: "#c4432f",
    src: "nws", apply: (on) => drawAnomaly(on),
    legend: () => `<span class="ll-ramp" style="background:linear-gradient(90deg,#2f6db5,#93b4d8 30%,#cfd5d2 50%,#f0a07a 70%,#c4432f)"></span>
      <span class="fine">Live NWS stations vs the valley floor nearby (−6 to +6 °C). Red dots up the slopes = a warm layer aloft: the inversion.</span>` });
  // Live stations arrive from map-live-inversion.js after load; redraw when they change.
  setInterval(() => { if (hub.state.layers.has("f-anom") && hub.DATA.wx !== lastWx) drawAnomaly(true); }, 3000);

  // Alerts: describe what is live in the Layers tab.
  const alertsLayer = hub.LAYERS.find((l) => l.id === "alerts");
  if (alertsLayer) {
    alertsLayer.name = "NWS weather & air alerts (live)";
    alertsLayer.legend = () => `<span class="fine">${!state.alertsLoaded ? "Loading active alerts…" : state.alertCount ? `${state.alertCount} active alert${state.alertCount > 1 ? "s" : ""} in Utah. Select an outlined area for details.` : "No active NWS alerts in Utah right now."}</span>`;
  }

  /* ---------- time ---------- */
  hub.onTime(() => {
    drawField();
    if (hub.state.layers.has("f-wind")) drawWind(true);
  });

  function wireMap(map) {
    // A style rebuild (e.g. terrain fallback) drops sources: redraw everything.
    map.on("style.load", () => { drawField(); drawWind(hub.state.layers.has("f-wind")); drawAnomaly(hub.state.layers.has("f-anom")); });
  }
  (function waitForMap() {
    if (hub.map) wireMap(hub.map); else setTimeout(waitForMap, 100);
  })();

  /* ---------- data ---------- */
  async function loadGrid() {
    try {
      state.grid = await getJson("/api/climate/grid");
      state.uv = null;
      for (const f of FIELD_IDS) if (hub.state.layers.has(f)) state.active = f;
      drawField();
      if (hub.state.layers.has("f-wind")) drawWind(true);
    } catch (error) {
      console.error(error);
      state.grid = state.grid || { fields: {}, times: [], lats: [], lons: [] };
    }
  }

  function centroid(geometry) {
    let w = 180, s = 90, e = -180, n = -90;
    const walk = (c) => (typeof c[0] === "number" ? (w = Math.min(w, c[0]), e = Math.max(e, c[0]), s = Math.min(s, c[1]), n = Math.max(n, c[1])) : c.forEach(walk));
    walk(geometry.coordinates);
    return { lat: (s + n) / 2, lng: (w + e) / 2 };
  }

  async function loadAlerts() {
    try {
      const data = await getJson("/api/alerts");
      const until = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }) : "until further notice");
      const items = data.features.map((f, i) => {
        const p = f.properties, c = centroid(f.geometry);
        return { id: `nws-${i}`, name: p.event || "NWS alert", lat: c.lat, lng: c.lng, geometry: f.geometry, live: true, src: "nws",
          until: until(p.ends), d: p.summary || p.headline || "", f: [["Severity", p.severity || "—"], ["Area", p.area || "—"]] };
      });
      state.alertsLoaded = true;
      state.alertCount = items.length + (data.unmapped || []).length;
      hub.registerData("alerts", items);
    } catch (error) {
      console.error(error);
      state.alertsLoaded = true;
      hub.refreshLayers();
    }
  }

  /* ---------- monitor detail: 48-hour trend chart (dark theme) ---------- */
  if (window.EnvCharts) {
    EnvCharts.setTheme({ ink: "#e7efe9", grid: "rgba(231,239,233,.10)", axis: "rgba(231,239,233,.28)", mark: "#9fd0e3",
      strong: "#9fd0e3", soft: "#6f8f88", accent: "#ff8066" });
  }
  const trendCache = new Map(); // gid -> element, so a time-slider re-render reattaches instead of refetching
  hub.onDetail((it, slot) => {
    if (!slot || it.layer !== "aq" || !window.EnvCharts) return;
    const cached = trendCache.get(it.gid);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) { slot.replaceChildren(cached.el); return; }
    const el = document.createElement("div");
    el.className = "box";
    el.innerHTML = `<h4>📈 Last 48 hours</h4><div class="env-chart"><p class="chart-empty">Loading recent readings…</p></div><p class="fine trend-note"></p>`;
    slot.replaceChildren(el);
    trendCache.set(it.gid, { el, at: Date.now() });
    getJson(`/api/air/history?lat=${it.lat}&lng=${it.lng}&hours=48`).then((data) => {
      EnvCharts.pmTrend(el.querySelector(".env-chart"), data);
      const s = data.station;
      el.querySelector(".trend-note").innerHTML = `Hourly PM2.5 and its 24-hour average at <b>${esc(s.name)}</b>${s.distance_km > 3 ? `, the nearest hourly feed (${s.distance_km} km away)` : ""}. Not quality-assured.`;
    }).catch(() => {
      el.querySelector(".env-chart").innerHTML = `<p class="chart-empty">Recent readings are unavailable right now.</p>`;
      trendCache.delete(it.gid);
    });
  });

  loadGrid();
  loadAlerts();
  setInterval(() => { if (document.visibilityState === "visible") { loadGrid(); loadAlerts(); } }, REFRESH_MS);
})();
