/* Homepage "Utah's air, in context" section: one filter row (monitor + time range) scopes all three charts. */
(function () {
  const DEFAULT = { lat: 40.7608, lng: -111.891 };
  const state = { station: "", hours: 72, lat: DEFAULT.lat, lng: DEFAULT.lng, monitors: null, stationInfo: null };
  const $ = (sel) => document.querySelector(sel);
  const trendEl = $("#trend-chart"), monitorEl = $("#monitor-chart"), outlookEl = $("#outlook-chart");
  if (!trendEl || !window.EnvCharts) return;

  const getJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url} ${r.status}`))));
  // Hold the previous render at reduced opacity while refetching, rather than flashing empty.
  const busy = (el, on) => el.classList.toggle("chart-loading", on);

  /** DAQ XML names are county-based ("Salt Lake County"); CSV stations carry the county too. */
  function isSelected(monitor) {
    const s = state.stationInfo;
    if (!s) return false;
    return monitor.name === `${s.county} County` || monitor.name === s.name || monitor.name === s.name.split(" ")[0];
  }

  function drawMonitors() {
    if (!state.monitors) return;
    EnvCharts.monitorBars(monitorEl, state.monitors, { highlight: isSelected });
    const mine = state.monitors.find(isSelected);
    $("#monitors-mine").textContent = mine ? `● marks the ${mine.name} monitor.` : "";
  }

  async function loadTrend() {
    busy(trendEl, true);
    const params = new URLSearchParams({ lat: state.lat, lng: state.lng, hours: state.hours });
    if (state.station) params.set("station", state.station);
    try {
      const data = await getJson(`/api/air/history?${params}`);
      state.stationInfo = data.station;
      fillStations(data.stations, data.station.id);
      const s = data.station, latest = data.latest;
      const span = state.hours <= 24 ? "last 24 hours" : `last ${Math.round(state.hours / 24)} days`;
      $("#trend-title").textContent = `Fine particles at ${s.name} (${s.county} County)`;
      $("#trend-sub").textContent = latest && latest.aqi != null
        ? `Now: 24-hour average ${latest.pm25_24h} µg/m³, which is AQI ${latest.aqi} (${latest.category}). Showing the ${span}.`
        : `Showing the ${span}. This monitor has no current 24-hour average.`;
      $("#trend-source").href = s.source_url;
      EnvCharts.pmTrend(trendEl, data);
      drawMonitors();
    } catch (error) {
      console.error(error);
      $("#trend-sub").textContent = "Utah DAQ readings are unavailable right now. Check air.utah.gov.";
      trendEl.innerHTML = `<p class="chart-empty">Could not load this monitor's readings.</p>`;
    } finally {
      busy(trendEl, false);
    }
  }

  let stationsFilled = false;
  function fillStations(stations, selectedId) {
    const select = $("#air-station");
    if (!stationsFilled && stations?.length) {
      stationsFilled = true;
      const nearest = stations[0];
      select.innerHTML = `<option value="">Nearest to Salt Lake City (${nearest.name})</option>` +
        [...stations].sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => `<option value="${s.id}" data-lat="${s.lat}" data-lng="${s.lng}">${s.name} · ${s.county} County</option>`).join("");
    }
    if (state.station) select.value = selectedId;
  }

  async function loadMonitors() {
    busy(monitorEl, true);
    try {
      state.monitors = (await getJson("/api/air/monitors")).monitors;
      drawMonitors();
    } catch (error) {
      console.error(error);
      EnvCharts.monitorBars(monitorEl, []);
    } finally {
      busy(monitorEl, false);
    }
  }

  async function loadOutlook() {
    busy(outlookEl, true);
    try {
      EnvCharts.outlook(outlookEl, await getJson(`/api/inversion/outlook?lat=${state.lat}&lng=${state.lng}`));
    } catch (error) {
      console.error(error);
      EnvCharts.outlook(outlookEl, []);
    } finally {
      busy(outlookEl, false);
    }
  }

  $("#air-station").addEventListener("change", (event) => {
    const option = event.target.selectedOptions[0];
    state.station = event.target.value;
    state.lat = option?.dataset.lat ? Number(option.dataset.lat) : DEFAULT.lat;
    state.lng = option?.dataset.lng ? Number(option.dataset.lng) : DEFAULT.lng;
    const where = option && state.station ? option.textContent.split(" · ")[0] : "Salt Lake City";
    $("#outlook-sub").textContent = `Seven-day inversion outlook near ${where}. A low afternoon mixing height plus a warm layer aloft in the morning means pollution builds up.`;
    loadTrend();
    loadOutlook();
  });

  document.querySelectorAll(".air-filters .seg").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".air-filters .seg").forEach((b) => {
      b.classList.toggle("active", b === button);
      b.setAttribute("aria-pressed", String(b === button));
    });
    state.hours = Number(button.dataset.hours);
    loadTrend();
  }));

  loadTrend();
  loadMonitors();
  loadOutlook();
})();
