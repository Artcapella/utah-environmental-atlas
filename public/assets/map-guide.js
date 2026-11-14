/* "Ask about the air": the environmental assistant on the map (moved here from the retired simple view).
 * POSTs to /api/guide/answer with mode "environmental" (Gemini tool agent over air, weather and
 * inversion data for wherever the map is centred) and renders cited Markdown with guide-renderer.js. */
(function () {
  "use strict";
  const hub = window.YOUtah, renderer = window.YouTahGuideRenderer;
  if (!hub || !renderer) return;
  const ENV_MODE = document.body.classList.contains("env-mode");
  const SUGGESTIONS = [
    "Is there an inversion today, and where can I get above it?",
    "How will air quality change over the next few days?",
    "Is it a good day to exercise outside here?",
  ];

  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.id = "guide-launcher";
  launcher.className = "guide-launcher";
  launcher.setAttribute("aria-controls", "guide-sheet");
  launcher.setAttribute("aria-expanded", "false");
  launcher.innerHTML = `<span aria-hidden="true">✦</span><span>${ENV_MODE ? "Ask about the air" : "Ask YOUtah"}</span>`;

  const sheet = document.createElement("section");
  sheet.id = "guide-sheet";
  sheet.className = "guide-sheet glass";
  sheet.hidden = true;
  sheet.setAttribute("aria-label", "YOUtah environmental assistant");
  sheet.innerHTML = `
    <header class="guide-heading">
      <div><p class="guide-eyebrow">Environmental assistant</p><h2>Ask about Utah's air and conditions.</h2></div>
      <button class="guide-close" type="button" aria-label="Close assistant">×</button>
    </header>
    <div class="guide-messages" aria-live="polite">
      <article class="guide-message assistant"><p>I answer from live Utah DAQ, National Weather Service and inversion data for wherever the map is centred, and cite every number.</p>
        <div class="guide-suggest">${SUGGESTIONS.map((q) => `<button type="button" data-q="${q.replace(/"/g, "&quot;")}">${q}</button>`).join("")}</div>
      </article>
    </div>
    <form class="guide-form">
      <label class="sr-only" for="guide-question">Your question</label>
      <textarea id="guide-question" rows="2" maxlength="600" placeholder="Is it smoggy today, and where is the air clean?"></textarea>
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
  let busy = false;

  function point() {
    const c = hub.map ? hub.map.getCenter() : { lat: 40.7608, lng: -111.891 };
    return { lat: Math.min(Math.max(c.lat, 36), 43), lng: Math.min(Math.max(c.lng, -114.2), -109) };
  }
  function updateWhere() {
    const p = point();
    where.textContent = `Answers for the map centre (${p.lat.toFixed(2)}, ${p.lng.toFixed(2)}). Move the map to ask about another place.`;
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
      const provider = document.createElement("span"); provider.className = "source-provider"; provider.textContent = c.source_name || "Source";
      copy.append(title, provider);
      item.append(label, copy);
      box.append(item);
    });
    el.append(box);
  }

  async function ask(text) {
    const q = text.trim();
    if (!q || busy) return;
    busy = true;
    send.disabled = true;
    append("user", q);
    const pending = append("assistant", "Checking live air and weather data…", "pending");
    const p = point();
    try {
      const response = await fetch("/api/guide/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, lat: p.lat, lng: p.lng, use_live_web: false, mode: ENV_MODE ? "environmental" : "travel" }),
      });
      if (!response.ok) throw new Error(`guide ${response.status}`);
      const result = await response.json();
      pending.remove();
      const el = append("assistant", result.answer || "I couldn't find an answer just now. Try again in a moment.", "", result.citations || []);
      appendSources(result.citations, el);
      messages.scrollTop += el.getBoundingClientRect().top - messages.getBoundingClientRect().top - 12;
    } catch (error) {
      console.error(error);
      pending.remove();
      append("assistant", "I'm having trouble connecting right now. Try again in a moment, or check air.utah.gov.", "error");
    } finally {
      busy = false;
      send.disabled = false;
    }
  }

  launcher.addEventListener("click", () => (sheet.hidden ? open() : close()));
  sheet.querySelector(".guide-close").addEventListener("click", close);
  sheet.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  messages.addEventListener("click", (e) => { const b = e.target.closest("[data-q]"); if (b) ask(b.dataset.q); });
  form.addEventListener("submit", (e) => { e.preventDefault(); const q = question.value; question.value = ""; ask(q); });
  question.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  (function waitForMap() { if (hub.map) hub.map.on("moveend", () => { if (!sheet.hidden) updateWhere(); }); else setTimeout(waitForMap, 150); })();

  window.YOUtahGuide = { ask: (q) => { open(); return ask(q); }, open, close };
})();
