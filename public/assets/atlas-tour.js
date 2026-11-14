/* The guided tour: a fixed list of stops for a legislator, each moving the map and then explaining what is on it.
 *
 * Played by map-guide.js ("Show me around", or the assistant's start_tour action); the actions run through
 * window.YOUtahAtlas.run (atlas-extras.js runAtlasActions). No model is involved and no number is quoted:
 * the stop points at the figure on the map or in the panel, so the text cannot drift from the engine.
 *
 * Every stop sets its whole scene (tab, layers, projects, scenario), so the tour can be entered at any
 * stop, walked backwards, or left halfway without leaving the map in a half-built state.
 * tests/atlas-tour.test.cjs checks that the stops cover every Impact tab, water layer and kind of measure.
 */
(function (root, factory) {
  const tour = factory();
  if (typeof module === "object" && module.exports) module.exports = tour;
  else root.YOUtahTour = tour;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ALL = ["stratos", "joule", "creekstone", "antelope", "red_butte", "nine_mile", "cyrusone_dugway", "tract_pole_canyon", "summit_ridge", "blusky_nephi"];
  const LAKE_BASIN = ["stratos", "tract_pole_canyon", "summit_ridge"];   // the registry projects that drain to the Great Salt Lake
  const CORE = ["atlas-projects", "atlas-lake", "atlas-permits"];        // on at every water stop
  const OPTIONAL = ["atlas-basinrisk", "atlas-water", "atlas-reference", "atlas-wbd-tiles", "atlas-fema-tiles", "f-pm", "f-mix"];
  const UTAH = { lat: 39.5, lng: -111.7, zoom: 6.1 }, STRATOS = { lat: 41.7, lng: -112.55, zoom: 7.6 }, LAKE = { lat: 41.15, lng: -112.5, zoom: 8 };

  /** The actions that put the app in one known state. `tab` is the Impact sub-tab; `top` the main tab. */
  function scene({ top = "impact", tab = "proposed", projects = ["stratos"], branch = "built", bills = [], layers = [], math = false,
                   dry = 100, compare = null, card = false, at = UTAH, focus = null } = {}) {
    return [
      ...(compare ? [] : [{ type: "close_compare" }]),
      { type: "inversion_card", open: card },
      ...CORE.map((id) => ({ type: "set_layer", id, on: true })),
      ...OPTIONAL.map((id) => ({ type: "set_layer", id, on: layers.includes(id) })),
      { type: "clear_levers" }, { type: "set_branch", branch }, { type: "select_projects", ids: projects },
      { type: "impact_tab", tab }, { type: "show_math", on: math }, { type: "set_basin", dry },
      ...bills.map((bill_id) => ({ type: "apply_bill", bill_id })),
      ...(compare ? [{ type: "open_compare", project_id: compare }] : []),
      { type: "open_tab", tab: top },
      { type: "fly_to", ...at },
      { type: "focus", ...(focus || { top: true }) },
    ];
  }

  const STOPS = [
    // ------------------------------------------------------------ the whole state
    { id: "overview", section: "Overview", title: "The whole state",
      actions: scene({ projects: ALL }),
      text: "This atlas shows how proposed data centers, and the bills that would regulate them, would affect Utah's water, the Great Salt Lake and the air. Each ring is a proposed data center: the bigger the ring, the more water the engine estimates it would use. Blue rings drain to the Great Salt Lake and brown rings to other basins. The small dots show how far each project is through permitting. The card over the map adds up every project selected and always gives the range with the estimate." },

    // ------------------------------------------------------------ one project and its footprint
    { id: "stratos", section: "One project", title: "Stratos",
      actions: scene({ at: STRATOS }),
      text: "This is Stratos in Box Elder County. The card at the top of the map gives the engine's estimate with its range, next to what the developer says. They are far apart, so the atlas shows both and picks neither. Click any ring for its figures and sources, and for a link that screens that proposal on its own." },
    { id: "water", section: "One project", title: "Water, three ways",
      actions: scene({ at: STRATOS, focus: { row: "Water" } }),
      text: "The Water row in the panel puts three figures side by side: what the developer or an agency says, the engine's estimate, and the highest figure on record. Every published figure carries a tag for the kind of source it comes from: government, developer, independent academic, advocacy-commissioned, or derived by the atlas. Below it, the test against current land use reads \"cannot test\" until the state supplies how much water the converted rights consume today." },
    { id: "air", section: "One project", title: "Air and climate",
      actions: scene({ at: STRATOS, focus: { row: "Air and climate" } }),
      text: "Stratos would generate its own power from natural gas, so the Air and climate row estimates the carbon dioxide and nitrogen oxides from that plant. Projects that take grid power show nothing here. That is not zero impact: their emissions happen at power plants elsewhere, which the engine does not model. Health costs are not computed either." },
    { id: "flags", section: "One project", title: "Habitat, wildfire and pollution",
      actions: scene({ at: STRATOS, focus: { row: "Biodiversity" } }),
      text: "The Biodiversity, Wildfire and Pollution rows are overlap flags, not estimates: species records and critical habitat, fire perimeters and recent detections, and toxic-release facilities near each site. An overlap is not a harm; it marks where to look. A row reads \"layer not loaded\" until that dataset has been fetched, and it never reads zero in the meantime." },

    // ------------------------------------------------------------ where the water is
    { id: "counties", section: "Where the water is", title: "Counties and watersheds",
      actions: scene({ projects: ["joule", "creekstone"], layers: ["atlas-water", "atlas-reference", "atlas-wbd-tiles"], at: { lat: 39.38, lng: -112.55, zoom: 7.2 } }),
      text: "County shading adds up the engine's water estimate for every proposed project in the county, all built as planned. The thin lines are federal watershed boundaries. Joule and Creekstone sit side by side in Millard County, in the Sevier River basin. That basin does not drain to the Great Salt Lake, so these two count toward water use but not toward the lake." },
    { id: "flood", section: "Where the water is", title: "Flood zones",
      actions: scene({ projects: ["tract_pole_canyon", "summit_ridge"], layers: ["atlas-fema-tiles", "atlas-reference"], at: { lat: 40.2, lng: -111.9, zoom: 9.6 } }),
      text: "Federal flood zones can be laid over any site. They are context for siting and are not part of the engine's estimate. FEMA has mapped only some areas, and the zones appear as you zoom in." },
    { id: "lake", section: "Where the water is", title: "Great Salt Lake and dust",
      actions: scene({ projects: LAKE_BASIN, at: LAKE, focus: { row: "Great Salt Lake and dust" } }),
      text: "The tan band inside the Great Salt Lake is the extra lakebed these projects would expose in the long run, built as planned. Exposed lakebed is where dust comes from. The band has the estimated area, not the real shape, which would follow the lake floor. Only projects in basins that drain to the lake are counted. The panel row gives the drop in lake level and sets it against the extra inflow the lake needs." },

    // ------------------------------------------------------------ what a bill would change
    { id: "bill-cooling", section: "Legislation", title: "A cooling standard",
      actions: scene({ tab: "legislation", bills: ["mock_dry_cooling"], at: STRATOS }),
      text: "Bills live in the Legislation tab. I applied a mock dry-cooling bill (an illustration, not real legislation). The red ring is Stratos built as planned; the dark ring is with the bill, and the label gives before and after. Air emissions do not change, which is the trade-off. You can also set each lever by hand, or paste bill text and confirm the levers the atlas reads from it." },
    { id: "bill-lake", section: "Legislation", title: "The same bill at the lake",
      actions: scene({ tab: "legislation", projects: LAKE_BASIN, bills: ["mock_dry_cooling"], at: LAKE }),
      text: "The same bill, seen at the lake. The red dashed outline is the lakebed exposed without the bill and the tan band is with it. A bill that changes water use upstream shows up here." },
    { id: "bill-offset", section: "Legislation", title: "A lake offset",
      actions: scene({ tab: "legislation", projects: LAKE_BASIN, bills: ["mock_gsl_offset"], at: LAKE }),
      text: "A second illustration: each project delivers an acre-foot to the lake for every acre-foot it consumes. The band disappears, leaving only the dashed outline of what would be exposed without the bill. The rings stay the same size, because the projects would use just as much water. Where the offset water would come from, and what it is used for today, is not modeled." },
    { id: "bill-grid", section: "Legislation", title: "No on-site gas",
      actions: scene({ tab: "legislation", bills: ["mock_grid_only"], at: STRATOS, focus: { row: "Air and climate" } }),
      text: "A third illustration prohibits on-site gas plants. The ring shrinks and on-site emissions fall away, because the power plant and its cooling water are gone. The power would come from the grid instead. Water and emissions at grid plants are not modeled, so this is a shift, not a statewide reduction, and the panel says so." },
    { id: "bill-reporting", section: "Legislation", title: "H.B. 76: reporting",
      actions: scene({ tab: "legislation", projects: ALL, bills: ["hb76_2026"] }),
      text: "Real measures are in the library too. H.B. 76 requires large data centers to report their water use. It changes what the state knows, not how much water is used: the estimates stay the same, and each project is marked as reporting or below the threshold. Until those reports arrive, no figure on this map is measured use." },
    { id: "bill-moratorium", section: "Legislation", title: "County moratoria",
      actions: scene({ tab: "legislation", projects: ["antelope", "red_butte"], bills: ["iron_2026_13"], at: { lat: 37.9, lng: -113.25, zoom: 7.4 } }),
      text: "Iron County's moratorium outlines the county and takes its projects out of the scenario. County moratoria are capped at 180 days, so this is a pause and not a decision. Other real measures in the library, such as H.B. 60 and the governor's executive order, set no lever; applying one explains what it changes instead of moving a ring." },
    { id: "branches", section: "Legislation", title: "Four branches",
      actions: scene({ compare: "stratos", at: STRATOS }),
      text: "The strip at the bottom compares four branches for one project: built as planned, built with conditions, scaled down, and not built here. Choose a card to draw that branch on the map. Not built here is not zero: the water stays in its current use, and a relocated project moves its impact somewhere else. Rows with no figure read \"not quantified\", and nothing is added up into a score." },

    // ------------------------------------------------------------ permits and basins
    { id: "permits", section: "Permits and basins", title: "Permit pipeline",
      actions: scene({ tab: "pipeline", projects: ALL }),
      text: "The Permits tab follows each project through five gates: land use, water right, air permit, water quality and construction. It names who decides at each gate and lists dated events and open decisions. \"Not found\" means no filing was found, not that none exists. Hollow dots are projects the engine does not yet estimate." },
    { id: "basins", section: "Permits and basins", title: "Basin water risk",
      actions: scene({ tab: "basins", projects: ALL, layers: ["atlas-basinrisk"] }),
      text: "The bubbles score each basin by setting data center demand against supply, the share of junior water rights, storage and trend. The baselines are placeholders until the state water divisions supply data, so read this as a demonstration of the method, not as findings. The scores use the scenario in the panel, so a bill's levers move them." },
    { id: "dry-year", section: "Permits and basins", title: "A dry year",
      actions: scene({ tab: "basins", projects: ALL, layers: ["atlas-basinrisk"], dry: 60 }),
      text: "I set supply to 60 percent of normal. Headroom shrinks, scores rise, and a J marks basins where demand would exceed supply and at least half the rights are junior, so junior rights would likely be cut first. The same placeholder caution applies." },

    // ------------------------------------------------------------ the record behind the numbers
    { id: "who-decides", section: "The record", title: "Who decides",
      actions: scene({ tab: "context" }),
      text: "This tab lists who decides what: the Legislature for statewide rules, the State Engineer for each water right, counties for zoning, and MIDA rather than the county at Stratos. It names the interim committees studying data centers and the legal context, including the 2026 law that narrowed what the State Engineer can weigh, which only the Legislature can change." },
    { id: "math", section: "The record", title: "Show the math",
      actions: scene({ math: true, at: STRATOS, focus: { sel: ".ip-math-box" } }),
      text: "Show the math lists every formula, each factor's low, central and high value with its source, and the assumptions made for each project. Where a developer has not said how a site will be cooled or powered, the range spans the possibilities. Copy citation and Download citation export the whole scenario as text for a committee file or a filing." },
    { id: "drop", section: "The record", title: "Test a site of your own",
      actions: scene({ tab: "drop" }),
      text: "Drop a project lets you test a hypothetical. Set a size, cooling type and power source, then click the map. The county is detected from the click and the project joins the scenario like any other. You can also paste a proposal and have its stated facts filled in, each with the quote it came from." },

    // ------------------------------------------------------------ pages to take away
    { id: "screen", section: "To take away", title: "Water screen",
      actions: scene({ at: STRATOS }),
      links: [{ href: "/screen?project=stratos", label: "Open the water screen for Stratos ↗" }],
      text: "Screen, beside each project, opens a review of that one proposal: a check of the developer's water claim, ways to use less water, red flags, questions to ask the developer, a scope for the hydrology study, and conditions of approval, ending in a memo. It is the page for a county commission, a water provider or committee staff preparing a hearing." },
    { id: "briefing", section: "To take away", title: "Briefing and the Stratos pilot",
      actions: scene({ projects: ALL }),
      links: [{ href: "/briefing", label: "Open the legislative briefing ↗" }, { href: "/atlas/pilots/stratos_who_pays.html", label: "Stratos: who pays ↗" }],
      text: "The briefing prints to one page: statewide totals, what each lever would change on its own, then by basin and by project, with a fixed box of data limits. It can be filtered to one county, and it is watermarked as a draft while basin baselines are placeholders. The Stratos pilot sets out the published, contested figures on who would bear the costs, with their sources." },

    // ------------------------------------------------------------ air today
    { id: "air-today", section: "Air today", title: "Air quality and inversions",
      actions: scene({ top: "today", layers: ["f-pm"], card: true, at: { lat: 40.72, lng: -111.9, zoom: 8.4 } }),
      links: [{ href: "/inversion", label: "Inversion map ↗" }, { href: "/about#air", label: "Air trends ↗" }],
      text: "The atlas also carries live air. The dots are state air monitors and the shaded field is the fine-particle forecast; the slider at the top of the panel runs it up to 72 hours ahead. The inversion card estimates whether a lid of warm air is holding pollution in the valleys today. Weather and air alerts from the National Weather Service are outlined on the map." },
    { id: "layers", section: "Air today", title: "Layers and sources",
      actions: scene({ top: "layers", layers: ["f-mix"], at: { lat: 40.72, lng: -111.9, zoom: 7.4 } }),
      text: "Everything the map can draw is listed in the Layers tab, each with its source. Data centers and water come first, then air and weather. I turned on mixing height: where it is low, pollution has little room to disperse. Temperature, wind arrows and the stations sitting warmer than the valley floor are here too." },

    // ------------------------------------------------------------ back to a clean map
    { id: "end", section: "End", title: "Ask anything",
      actions: scene(),
      text: "That is the tour, and the map is back where it started. Ask me where any number comes from or what a bill would change, and I will show it on the map." },
  ];

  /** First stop of each section, for the "jump to" row. */
  const sections = () => STOPS.reduce((out, s, index) => (out.some((x) => x.section === s.section) ? out : [...out, { section: s.section, index }]), []);

  return { STOPS, sections, ALL, CORE, OPTIONAL };
});
