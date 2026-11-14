/* The atlas guide: a chat that explains the atlas's sources and moves the map to show the answer.
 *
 * Environmental mode POSTs to /api/atlas/ask (backend/atlas/assistant.py: Gemini tool agent, OpenAI backup,
 * quoted sources as a last resort). The reply carries cited Markdown plus `actions`; window.YOUtahAtlas.run
 * (map-atlas.js) executes them, so the map, not the chat, carries the answer. "Show me around" runs a fixed
 * tour of the same actions and needs no model. Travel mode keeps the older /api/guide/answer planner. */
(function () {
  "use strict";
  const hub = window.YOUtah, renderer = window.YouTahGuideRenderer;
  if (!hub || !renderer) return;
  const ENV_MODE = document.body.classList.contains("env-mode");
  const TAGS = { gov: "Government", dev: "Developer", ind: "Independent academic", adv: "Advocacy-commissioned", der: "Derived by the atlas" };
  const SUGGESTIONS = ENV_MODE ? [
    "Show me around",
    "How much water would Stratos use, and who says so?",
    "What would a dry-cooling bill change on the map?",
    "Which numbers here are still placeholders?",
    "Is there an inversion today?",
  ] : ["Is there an inversion today, and where can I get above it?", "How will air quality change over the next few days?"];

  // Fixed tour: each step moves the map, then explains what is on it.
  const TOUR = [
    { actions: [{ type: "close_compare" }, { type: "open_tab", tab: "impact" }, { type: "clear_levers" }, { type: "set_branch", branch: "built" },
                { type: "impact_tab", tab: "proposed" }, { type: "fly_to", lat: 39.6, lng: -111.9, zoom: 6.1 }],
      text: "This atlas shows how proposed data centers, and the bills that would regulate them, would affect Utah's water and the Great Salt Lake. Each ring is a proposed data center: the bigger the ring, the more water the engine estimates it would use. The small dots show how far each project is through permitting." },
    { actions: [{ type: "select_projects", ids: ["stratos"] }, { type: "fly_to", lat: 41.7, lng: -112.55, zoom: 7.6 }],
      text: "This is Stratos in Box Elder County. The card at the top of the map gives the engine's estimate with its range, next to what the developer says. They are far apart, so the atlas shows both and picks neither. Click any ring for its figures and sources." },
    { actions: [{ type: "impact_tab", tab: "legislation" }, { type: "apply_bill", bill_id: "mock_dry_cooling" }],
      text: "Bills live in the Legislation tab. I applied a mock dry-cooling bill (an illustration, not real legislation). The red ring is Stratos built as planned; the dark ring is with the bill, and the label gives before and after. Air emissions do not change, which is the trade-off." },
    { actions: [{ type: "set_layer", id: "atlas-lake", on: true }, { type: "fly_to", lat: 41.15, lng: -112.5, zoom: 8 }],
      text: "The tan band inside the Great Salt Lake is the extra lakebed this scenario would expose in the long run. The red dashed outline is the same thing without the bill. The band has the estimated area, not the real shape." },
    { actions: [{ type: "clear_levers" }, { type: "select_projects", ids: ["antelope", "red_butte"] }, { type: "apply_bill", bill_id: "iron_2026_13" },
                { type: "fly_to", lat: 37.9, lng: -113.25, zoom: 7.4 }],
      text: "Real measures are in the library too. Iron County's moratorium outlines the county and takes its projects out of the scenario. Other measures, such as H.B. 76's reporting rule, change what the state knows and not water use, and the map says so." },
    { actions: [{ type: "clear_levers" }, { type: "set_branch", branch: "built" }, { type: "open_compare", project_id: "stratos" }],
      text: "The strip at the bottom compares four branches for one project: built as planned, built with conditions, scaled down, and not built here. Choose a card to draw that branch on the map. Not built here is not zero: the water stays in its current use, and a relocated project moves its impact somewhere else." },
    { actions: [{ type: "close_compare" }, { type: "impact_tab", tab: "basins" }, { type: "set_layer", id: "atlas-basinrisk", on: true }, { type: "fly_to", lat: 39.6, lng: -111.9, zoom: 6.1 }],
      text: "The bubbles show relative water risk by basin. Their baselines are placeholders until the state water divisions supply data, so read them as a demonstration of the method, not as findings." },
    { actions: [{ type: "set_layer", id: "atlas-basinrisk", on: false }, { type: "impact_tab", tab: "proposed" }],
      text: "That is the tour. Ask me where any number comes from or what a bill would change, and I will show it on the map. The Briefing link prints a one-page summary with its data limits." },
  ];

  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.id = "guide-launcher";
  launcher.className = "guide-launcher";
  launcher.setAttribute("aria-controls", "guide-sheet");
  launcher.setAttribute("aria-expanded", "false");
  launcher.innerHTML = `<span aria-hidden="true">✦</span><span>${ENV_MODE ? "Ask the atlas" : "Ask YOUtah"}</span>`;

  const sheet = document.createElement("section");
  sheet.id = "guide-sheet";
  sheet.className = "guide-sheet glass";
  sheet.hidden = true;
  sheet.setAttribute("aria-label", "Atlas guide");
  sheet.innerHTML = `
    <header class="guide-heading">
      <div><p class="guide-eyebrow">Atlas guide</p><h2>${ENV_MODE ? "Ask about water, data centers and the bills." : "Ask about Utah's air and conditions."}</h2></div>
      <button class="guide-close" type="button" aria-label="Close the guide">×</button>
    </header>
    <div class="guide-messages" aria-live="polite">
      <article class="guide-message assistant"><p>${ENV_MODE
        ? "I explain where the atlas's numbers come from and move the map to show them. Every figure is cited with the kind of source it comes from."
        : "I answer from live Utah DAQ, National Weather Service and inversion data for wherever the map is centred, and cite every number."}</p>
        <div class="guide-suggest">${SUGGESTIONS.map((q) => `<button type="button" data-q="${q.replace(/"/g, "&quot;")}">${q}</button>`).join("")}</div>
      </article>
    </div>
    <form class="guide-form">
      <label class="sr-only" for="guide-question">Your question</label>
      <textarea id="guide-question" rows="2" maxlength="600" placeholder="${ENV_MODE ? "What would H.B. 76 change?" : "Is it smoggy today, and where is the air clean?"}"></textarea>
      <span class="guide-where"></span>
      <button class="guide-send" type="submit"><span>Ask</span><span aria-hidden="true">↗</span></button>
    </form>`;
  document.getElementById("fabs").prepend(launcher);
  document.body.appendChild(sheet);

  const messages = sheet.querySelector(".guide-messages");
  const form = sheet.querySelector(".guide-form");
  const question = sheet.querySelector("#guide-question");
  const send = sheet.querySelector(".guide-send");
  const where = sheet.querySelector(".guide-where");
  const history = [];
  let busy = false, tourStep = -1;

  function point() {
    const c = hub.map ? hub.map.getCenter() : { lat: 40.7608, lng: -111.891 };
    return { lat: Math.min(Math.max(c.lat, 36), 43), lng: Math.min(Math.max(c.lng, -114.2), -109) };
  }
  function updateWhere() {
    where.textContent = ENV_MODE ? "Answers use what the map is showing. Air questions use the map centre."
      : `Answers for the map centre (${point().lat.toFixed(2)}, ${point().lng.toFixed(2)}).`;
  }
  function open() {
    sheet.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    document.body.classList.add("guide-open");
    updateWhere();
    setTimeout(() => question.focus(), 0);
  }
  function close() {
    sheet.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
    document.body.classList.remove("guide-open");
    launcher.focus();
  }

  function append(kind, text, extra = "", citations = []) {
    const el = document.createElement("article");
    el.className = `guide-message ${kind} ${extra}`.trim();
    if (kind === "assistant" && !extra) el.innerHTML = renderer.renderMarkdown(text, citations);
    else { const p = document.createElement("p"); p.textContent = text; el.append(p); }
    messages.append(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }
  function note(el, cls, text) {
    const p = document.createElement("p");
    p.className = cls;
    p.textContent = text;
    el.append(p);
    return p;
  }

  function appendSources(citations, el) {
    if (!Array.isArray(citations) || !citations.length) return;
    const box = document.createElement("section");
    box.className = "guide-sources";
    box.setAttribute("aria-label", "Sources for this answer");
    box.innerHTML = `<h4>Sources</h4>`;
    citations.forEach((c, i) => {
      const url = renderer.safeUrl(c.url);
      const item = document.createElement(url ? "a" : "div");
      item.className = `guide-source${url ? "" : " no-link"}`;
      if (url) { item.href = url; item.target = "_blank"; item.rel = "noopener noreferrer"; }
      const label = document.createElement("span"); label.className = "source-label"; label.textContent = renderer.citationLabel(c, i);
      const copy = document.createElement("span"); copy.className = "source-copy";
      const title = document.createElement("span"); title.className = "source-name"; title.textContent = c.title || c.source_name || "Source";
      const provider = document.createElement("span"); provider.className = "source-provider";
      // Source type and caveats travel with every citation, in words rather than colour.
      provider.textContent = [c.source_name || "Source", TAGS[c.source_type], c.placeholder ? "placeholder baselines" : null,
                              c.verified === false ? "not yet verified" : null].filter(Boolean).join(" · ");
      copy.append(title, provider);
      item.append(label, copy);
      if (typeof c.lat === "number" && typeof c.lng === "number" && hub.map) {
        const go = document.createElement("button");
        go.type = "button"; go.className = "source-map"; go.textContent = "Show on map";
        go.addEventListener("click", (e) => { e.preventDefault(); hub.map.flyTo({ center: [c.lng, c.lat], zoom: 8.5 }); });
        item.append(go);
      }
      box.append(item);
    });
    el.append(box);
  }

  async function runActions(actions, el) {
    const list = Array.isArray(actions) ? actions : [];
    if (!list.length) return;
    let done = [];
    try { done = window.YOUtahAtlas ? await window.YOUtahAtlas.run(list) : []; } catch (e) { console.error(e); }
    const box = document.createElement("div");
    box.className = "guide-actions";
    if (done.length) {
      const head = document.createElement("span"); head.className = "guide-actions-h"; head.textContent = "On the map";
      box.append(head, ...done.map((t) => Object.assign(document.createElement("span"), { className: "guide-action", textContent: t })));
    }
    if (list.some((a) => a.type === "open_briefing")) {
      box.append(Object.assign(document.createElement("a"), { className: "guide-action link", href: "/briefing", target: "_blank", rel: "noopener", textContent: "Open the legislative briefing ↗" }));
    }
    if (box.childNodes.length && el) el.append(box);
    if (list.some((a) => a.type === "start_tour")) startTour();
  }

  async function showTourStep(i) {
    tourStep = i;
    const step = TOUR[i];
    const el = append("assistant", `**Tour, step ${i + 1} of ${TOUR.length}.** ${step.text}`);
    await runActions(step.actions.map((a) => ({ ...a, label: "" })), null);
    const row = document.createElement("div");
    row.className = "guide-suggest tour";
    const last = i === TOUR.length - 1;
    row.innerHTML = last ? "" : `<button type="button" data-tour="next">Next ›</button><button type="button" data-tour="end">End tour</button>`;
    if (!last) el.append(row); else tourStep = -1;
    messages.scrollTop = messages.scrollHeight;
  }
  function startTour() { showTourStep(0); }

  async function ask(text) {
    const q = text.trim();
    if (!q || busy) return;
    busy = true;
    send.disabled = true;
    append("user", q);
    const pending = append("assistant", ENV_MODE ? "Checking the atlas's sources and the impact engine…" : "Checking live air and weather data…", "pending");
    const p = point();
    try {
      const body = ENV_MODE
        ? { query: q, lat: p.lat, lng: p.lng, history: history.slice(-8), app: window.YOUtahAtlas ? window.YOUtahAtlas.state() : null }
        : { query: q, lat: p.lat, lng: p.lng, use_live_web: false, mode: "travel" };
      const response = await fetch(ENV_MODE ? "/api/atlas/ask" : "/api/guide/answer", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`guide ${response.status}`);
      const result = await response.json();
      pending.remove();
      const answer = result.answer || "I couldn't find an answer just now. Try again in a moment.";
      const el = append("assistant", answer, "", result.citations || []);
      history.push({ role: "user", text: q }, { role: "assistant", text: answer.slice(0, 3500) });
      if (result.grounded === false && (result.unverified_numbers || []).length) {
        note(el, "guide-caution", `These figures could not be matched to a source and may be wrong: ${result.unverified_numbers.join(", ")}.`);
      }
      await runActions(result.actions, el);
      appendSources(result.citations, el);
      if (ENV_MODE) note(el, "guide-agent", { gemini: "Written by Gemini from the atlas's sources and engine.", openai: "Written by OpenAI from the atlas's sources and engine.",
                                              local_fallback: "Quoted directly from the atlas's sources; no AI model was available." }[result.agent] || "");
      messages.scrollTop += el.getBoundingClientRect().top - messages.getBoundingClientRect().top - 12;
    } catch (error) {
      console.error(error);
      pending.remove();
      append("assistant", "I'm having trouble connecting right now. Try again in a moment.", "error");
    } finally {
      busy = false;
      send.disabled = false;
    }
  }

  launcher.addEventListener("click", () => (sheet.hidden ? open() : close()));
  sheet.querySelector(".guide-close").addEventListener("click", close);
  sheet.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  messages.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tour]");
    if (t) {
      t.parentElement.remove();
      if (t.dataset.tour === "next" && tourStep >= 0 && tourStep < TOUR.length - 1) showTourStep(tourStep + 1);
      else { tourStep = -1; append("assistant", "Tour ended. Ask me anything about what is on the map."); }
      return;
    }
    const b = e.target.closest("[data-q]");
    if (!b) return;
    if (ENV_MODE && /^show me around$/i.test(b.dataset.q)) { append("user", b.dataset.q); startTour(); } else ask(b.dataset.q);
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); const q = question.value; question.value = ""; ask(q); });
  question.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });

  window.YOUtahGuide = { ask: (q) => { open(); return ask(q); }, open, close, startTour: () => { open(); startTour(); } };
})();
