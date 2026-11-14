"""Utah Environmental Atlas - impact engine.

Deterministic, sourced factor model. Every output is a (low, central, high) range.
Gemini never produces numbers; it only fills Project/Lever fields and narrates results.

Drop into: backend/intelligence/impact_engine.py
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field, asdict, replace
from pathlib import Path
from typing import Literal, Optional

L_PER_AF = 1_233_482          # litres per acre-foot
GAL_PER_AF = 325_851          # gallons per acre-foot
HOURS = 8760

# ---------------------------------------------------------------- factors
# (low, central, high, source) - keep in sync with the design doc factor table
FACTORS = {
    "wue_evap":      (1.5, 1.8, 3.0, "Introl / aquaray: evaporative WUE, US avg 1.8 L/kWh"),
    "wue_closed":    (0.0, 0.04, 0.2, "LBNL via VoxBooster; preprints.org WUE review"),
    "pue":           (1.1, 1.3, 1.4, "Tetra Tech 2026 (US avg ~1.40); hyperscale low end assumed"),
    "load_factor":   (0.6, 0.8, 0.95, "Assumption (UI adjustable)"),
    "gal_mwh_wet":   (130, 200, 300, "UCS: NGCC recirculating consumption, gal/MWh"),
    "gal_mwh_dry":   (0, 2, 4, "UCS: NGCC dry cooling, gal/MWh"),
    "co2_lb_mwh":    (771, 800, 832, "EPA Clean Power Plan NGCC rates"),
    "nox_lb_mmbtu":  (0.0178, 0.0178, 0.0178, "EPA Table 3-29: 4 ppm NGCC limit"),
    "heat_rate":     (6.5, 7.0, 7.5, "Assumption, MMBtu/MWh"),
    "gsl_ft_per_100k": (0.7, 1.0, 1.3, "Utah GSL water-budget study; +/-30% band assumed"),
    "playa_ac_per_ft": (25_000, 31_000, 35_000, "Derived: 610,200 ac @4191.3 ft, ~817k ac @4198 ft"),
}

Range = tuple[float, float, float]

# Source-type tags (distinct outlines in the UI, not color-only)
SOURCE_TYPES = {"gov": "Government", "dev": "Developer", "ind": "Independent academic",
                "adv": "Advocacy-commissioned", "der": "Derived (our arithmetic)"}
BRANCHES = {"built": "Built as planned", "conditions": "Built with conditions",
            "scaled": "Delayed or scaled down", "not_built": "Not built here"}


def f(name: str) -> Range:
    lo, c, hi, _ = FACTORS[name]
    return (lo, c, hi)


# ---------------------------------------------------------------- models
Cooling = Optional[Literal["evaporative", "closed_loop"]]
PowerCooling = Optional[Literal["wet", "dry"]]
WaterSource = Literal["basin", "produced_water"]


@dataclass
class Figure:
    """A published water figure, shown beside the engine range; never overwritten."""
    label: str
    value_af: float
    source_types: list[str]
    source: str
    url: str = ""


@dataclass
class Project:
    id: str
    name: str
    county: str
    lat: float
    lon: float
    mw: Optional[float]                    # announced facility MW (None = unknown)
    kind: str = "data_center"
    cooling: Cooling = None                # None = unknown -> spans both
    onsite_gas: Optional[bool] = None      # None = unknown -> spans grid..gas
    power_cooling: PowerCooling = None     # None = unknown -> spans dry..wet
    gsl_basin: bool = False                # drains to Great Salt Lake?
    water_source: WaterSource = "basin"
    footprint_acres: Optional[float] = None
    stated_af: Optional[float] = None      # developer-stated annual use
    rights_af: Optional[float] = None      # water rights held or sought
    published_high_af: Optional[float] = None  # highest published independent estimate
    basin: str = "Unassigned"              # approximate hydrologic basin (briefing drill-down)
    baseline_consumptive_af: Optional[float] = None  # current use of land/rights converted (Water Rights data)
    size_options_mw: dict[str, float] = field(default_factory=dict)
    figures: list[Figure] = field(default_factory=list)
    status: str = ""
    notes: str = ""
    coords_approx: bool = True


@dataclass
class Levers:
    cooling_required: Optional[Literal["closed_loop", "any"]] = None
    max_wue: Optional[float] = None
    onsite_gas_allowed: Optional[bool] = None
    power_cooling_required: Optional[Literal["dry", "any"]] = None
    gsl_offset_ratio: Optional[float] = None
    moratorium_counties: list[str] = field(default_factory=list)
    habitat_setback_km: Optional[float] = None
    reporting_threshold_af: Optional[float] = None


# ---------------------------------------------------------------- registry
# Seeded from mid-2026 news/county filings. Coordinates are approximate.
REGISTRY: list[Project] = [
    Project("stratos", "Stratos / Wonder Valley", "Box Elder", 41.70, -112.55, 9000,
            onsite_gas=True, gsl_basin=True, stated_af=1215, rights_af=13000,
            footprint_acres=40000, basin="Bear River / GSL", published_high_af=100000,
            status="County approved May 2026",
            notes="Rights: ~3,000 AF purchase + ~10,000 AF under contract. Footprint reported down to ~20,000 ac.",
            size_options_mw={"Full buildout, 9 GW": 9000, "First phase, 3 GW (health report)": 3000,
                             "First phase, up to 1.5 GW (governor)": 1500},
            figures=[
                Figure("Net depletion at full buildout", 987, ["dev"], "Developer engineering report via Salt Lake Tribune, Oct 2026"),
                Figure("Diversion at full buildout", 1215, ["dev"], "Developer engineering report via Salt Lake Tribune, Oct 2026"),
                Figure("Water use cited by DNR director", 1900, ["gov"], "KUTV, May 2026",
                       "https://kutv.com/newsletter-daily/utah-lawmakers-vote-to-study-impacts-of-box-elder-county-data-center"),
                Figure("Gas engines, ~2 billion gal/yr converted", 6100, ["adv", "der"], "Utah Clean Energy",
                       "https://utahcleanenergy.org/estimated-emissions-and-water-consumption-from-the-proposed-stratos-data-center/"),
                Figure("Combined-cycle turbines", 50000, ["ind"], "Independent estimate in project research notes"),
                Figure("BYU ecologist estimate", 100000, ["ind"], "Project research notes"),
            ]),
    Project("joule", "Joule campus", "Millard", 39.36, -112.58, 4000,
            cooling="closed_loop", onsite_gas=True, rights_af=10000,
            basin="Sevier River", status="Phase 1 (455 MW) under construction"),
    Project("creekstone", "Creekstone Delta Gigasite", "Millard", 39.40, -112.50, 10000,
            cooling="closed_loop", stated_af=200, basin="Sevier River", status="Phase 1 (220 MW) under construction",
            notes="Stated: up to 2 AF per 100 MW"),
    Project("antelope", "Antelope (Pronghorn)", "Iron", 37.90, -113.30, 1500,
            onsite_gas=True, stated_af=10.8, basin="Cedar/Beaver", status="County permit June 2026",
            notes="Basin water rights fully appropriated"),
    Project("red_butte", "Red Butte (BrightNight)", "Iron", 37.85, -113.20, 1500,
            basin="Cedar/Beaver", status="Held by county moratorium"),
    Project("nine_mile", "Nine Mile (Energence)", "Duchesne", 39.90, -110.40, 400,
            water_source="produced_water", basin="Uinta (Colorado River)", status="County permits April 2026",
            notes="Paired with produced-water recycling (reWater LLC)"),
    Project("cyrusone_dugway", "CyrusOne at Dugway", "Tooele", 40.22, -112.75, 1000,
            cooling="closed_loop", basin="West Desert", status="Proposed",
            notes="CyrusOne committed to water-free cooling for new builds"),
    Project("tract_pole_canyon", "Tract Pole Canyon / Pony Express", "Utah", 40.31, -112.05, 1820,
            gsl_basin=True, basin="Utah Lake / Jordan", status="First phase planned 2028"),
    Project("summit_ridge", "Summit Ridge (DCPC)", "Utah", 39.97, -111.78, 500,
            gsl_basin=True, basin="Utah Lake / Jordan", status="20 MW approved; 500 MW JV"),
    Project("blusky_nephi", "BluSky Nephi", "Juab", 39.71, -111.84, 9.3, basin="Sevier River", status="Smaller"),
]
REGISTRY_BY_ID = {p.id: p for p in REGISTRY}


# ---------------------------------------------------------------- levers
def apply_levers(projects: list[Project], lv: Levers) -> tuple[list[Project], list[dict]]:
    """Return modified projects plus a log of what each lever changed."""
    out, log = [], []
    blocked = {c.lower() for c in lv.moratorium_counties}
    for p in projects:
        if p.county.lower() in blocked:
            log.append({"project": p.id, "lever": "moratorium_counties", "effect": "removed"})
            continue
        q = p
        if lv.cooling_required == "closed_loop" and q.cooling != "closed_loop":
            q = replace(q, cooling="closed_loop")
            log.append({"project": p.id, "lever": "cooling_required", "effect": "closed_loop"})
        if lv.onsite_gas_allowed is False and q.onsite_gas is not False:
            q = replace(q, onsite_gas=False)
            log.append({"project": p.id, "lever": "onsite_gas_allowed",
                        "effect": "shifted to grid (impacts move off-site, not modeled)"})
        if lv.power_cooling_required == "dry" and q.power_cooling != "dry":
            q = replace(q, power_cooling="dry")
            log.append({"project": p.id, "lever": "power_cooling_required", "effect": "dry"})
        out.append(q)
    return out, log


# ---------------------------------------------------------------- math
def _span(vals: list[float]) -> Range:
    return (min(vals), sorted(vals)[len(vals) // 2], max(vals))


def _wue(p: Project, lv: Levers) -> Range:
    if p.cooling == "closed_loop":
        r = f("wue_closed")
    elif p.cooling == "evaporative":
        r = f("wue_evap")
    else:  # unknown: central = closed-loop (most new Utah builds claim it); high = evaporative
        r = (f("wue_closed")[0], f("wue_closed")[1], f("wue_evap")[2])
    if lv.max_wue is not None:
        r = tuple(min(x, lv.max_wue) for x in r)
    return r


def _gas_share(p: Project) -> Range:
    return {True: (1, 1, 1), False: (0, 0, 0)}.get(p.onsite_gas, (0, 1, 1))


def _gal_mwh(p: Project) -> Range:
    if p.power_cooling == "dry":
        return f("gal_mwh_dry")
    if p.power_cooling == "wet":
        return f("gal_mwh_wet")
    return (f("gal_mwh_dry")[0], f("gal_mwh_wet")[1], f("gal_mwh_wet")[2])


def project_impacts(p: Project, lv: Levers) -> dict:
    if p.mw is None:
        return {"project": p.id, "name": p.name, "error": "size unknown"}
    lf, pue, wue = f("load_factor"), f("pue"), _wue(p, lv)
    gas, gal = _gas_share(p), _gal_mwh(p)
    # low = all-low inputs, high = all-high (PUE inverted for IT load)
    mwh = tuple(p.mw * HOURS * lf[i] for i in range(3))
    it_mwh = (mwh[0] / pue[2], mwh[1] / pue[1], mwh[2] / pue[0])
    af_site = tuple(it_mwh[i] * 1000 * wue[i] / L_PER_AF for i in range(3))
    af_power = tuple(mwh[i] * gal[i] * gas[i] / GAL_PER_AF for i in range(3))
    af_total = tuple(af_site[i] + af_power[i] for i in range(3))

    co2 = tuple(mwh[i] * gas[i] * f("co2_lb_mwh")[i] / 2000 for i in range(3))
    nox = tuple(mwh[i] * gas[i] * f("heat_rate")[i] * f("nox_lb_mmbtu")[i] / 2000 for i in range(3))

    net = None if p.baseline_consumptive_af is None else tuple(x - p.baseline_consumptive_af for x in af_total)
    if net is None:
        eo_test = "Cannot test: current consumptive use of the converted land/rights is unknown"
    elif net[1] <= 0:
        eo_test = "Central estimate does not increase consumption over current use"
    else:
        eo_test = "Central estimate increases consumption over current use"

    depletion = af_total if (p.gsl_basin and p.water_source == "basin") else (0, 0, 0)
    if lv.gsl_offset_ratio:
        depletion = tuple(d * max(0.0, 1 - lv.gsl_offset_ratio) for d in depletion)

    visible = None
    if lv.reporting_threshold_af is not None:
        visible = af_total[1] >= lv.reporting_threshold_af

    return {
        "project": p.id, "name": p.name, "county": p.county,
        "basin": p.basin,
        "water_af": {"site": af_site, "power": af_power, "total": af_total,
                     "stated": p.stated_af, "rights": p.rights_af,
                     "published_high": p.published_high_af,
                     "figures": [asdict(x) for x in p.figures],
                     "baseline_consumptive": p.baseline_consumptive_af,
                     "net_vs_current": net, "eo_2026_03_test": eo_test},
        "gsl_depletion_af": depletion,
        "air_tons": {"co2": co2, "nox": nox},
        "reporting_visible": visible,
        "assumptions": {
            "cooling": p.cooling or "unknown (range spans closed-loop..evaporative)",
            "onsite_gas": {True: "yes", False: "no"}.get(p.onsite_gas, "unknown (range spans grid..gas)"),
            "power_cooling": p.power_cooling or "unknown (range spans dry..wet)",
        },
    }


def gsl_effect(total_depletion: Range) -> dict:
    ft = tuple(total_depletion[i] / 100_000 * f("gsl_ft_per_100k")[i] for i in range(3))
    playa = tuple(ft[i] * f("playa_ac_per_ft")[i] for i in range(3))
    return {"level_drop_ft": ft, "playa_acres": playa,
            "note": "Long-run equilibrium estimate; effect is larger at low lake levels."}


# ---------------------------------------------------------------- overlaps
def overlap_flags(p: Project, layers_dir: Path | None) -> dict:
    """Count features near the site from cached GeoJSON. Returns {} if layers absent."""
    if not layers_dir or not layers_dir.exists():
        return {}
    try:
        from shapely.geometry import Point, shape
    except ImportError:
        return {"error": "shapely not installed"}
    acres = p.footprint_acres or 640
    r_m = math.sqrt(acres * 4046.86 / math.pi) + 5000          # footprint + 5 km buffer
    deg = r_m / 111_320
    site = Point(p.lon, p.lat).buffer(deg)  # crude; fine at Utah latitudes for a demo
    out = {}
    for fname, key in [("critical_habitat.geojson", "critical_habitat_features"),
                       ("tri_facilities.geojson", "tri_facilities"),
                       ("firms_7d.geojson", "fire_detections_7d"),
                       ("fire_perimeters.geojson", "fire_perimeters_since_2020"),
                       ("gbif_hex.geojson", "gbif_hexes")]:
        fp = layers_dir / fname
        if not fp.exists():
            continue
        feats = json.loads(fp.read_text())["features"]
        hits = [ft for ft in feats if ft.get("geometry") and shape(ft["geometry"]).intersects(site)]
        out[key] = len(hits)
        if key == "gbif_hexes":
            out["species_records_near"] = sum(int(h["properties"].get("species", 0)) for h in hits)
    out["buffer_km"] = round(r_m / 1000, 1)
    return out


# ---------------------------------------------------------------- scenario
def run_scenario(project_ids: list[str], custom: list[Project] | None = None,
                 levers: Levers | None = None, layers_dir: Path | None = None,
                 branch: str = "built", scale: float = 1.0,
                 sizes: dict[str, float] | None = None) -> dict:
    """branch: built | conditions (apply levers) | scaled (mw x scale) | not_built.
    sizes: optional {project_id: mw} override, e.g. a phase from size_options_mw."""
    lv = levers or Levers()
    if branch == "built":
        lv = Levers(moratorium_counties=lv.moratorium_counties,
                    reporting_threshold_af=lv.reporting_threshold_af)  # no design conditions
    base = [REGISTRY_BY_ID[i] for i in project_ids if i in REGISTRY_BY_ID] + list(custom or [])
    base = [replace(p, mw=sizes[p.id]) if sizes and p.id in sizes else p for p in base]
    if branch == "scaled":
        base = [replace(p, mw=p.mw * scale) if p.mw else p for p in base]
    projects, lever_log = apply_levers(base, lv)
    if branch == "not_built":
        rows = [{"project": p.id, "name": p.name, "basin": p.basin, "not_built": True,
                 "note": "Water stays in its current use. If the project relocates, impacts move "
                         "elsewhere: unknown, not zero."} for p in projects]
    else:
        rows = [project_impacts(p, lv) for p in projects]
    for p, r in zip(projects, rows):
        r["overlaps"] = {} if r.get("not_built") else overlap_flags(p, layers_dir)
        if lv.habitat_setback_km and r["overlaps"].get("critical_habitat_features"):
            r["habitat_flag"] = f"within ~{r['overlaps']['buffer_km']} km of critical habitat"
    ok = [r for r in rows if "error" not in r and not r.get("not_built")]

    def tot(get) -> Range:
        return tuple(sum(get(r)[i] for r in ok) for i in range(3))

    totals = {
        "water_af": tot(lambda r: r["water_af"]["total"]),
        "stated_af": sum(r["water_af"]["stated"] or 0 for r in ok),
        "rights_af": sum(r["water_af"]["rights"] or 0 for r in ok),
        "co2_tons": tot(lambda r: r["air_tons"]["co2"]),
        "nox_tons": tot(lambda r: r["air_tons"]["nox"]),
        "gsl": gsl_effect(tot(lambda r: r["gsl_depletion_af"])),
    }
    by_basin = {}
    for r in ok:
        b = by_basin.setdefault(r["basin"], {"projects": [], "water_af": (0, 0, 0), "stated_af": 0})
        b["projects"].append(r["project"])
        b["water_af"] = tuple(b["water_af"][i] + r["water_af"]["total"][i] for i in range(3))
        b["stated_af"] += r["water_af"]["stated"] or 0
    return {"branch": branch, "branch_label": BRANCHES.get(branch, branch),
            "projects": rows, "totals": totals, "by_basin": by_basin, "lever_log": lever_log,
            "source_types": SOURCE_TYPES,
            "factors": {k: {"low": v[0], "central": v[1], "high": v[2], "source": v[3]}
                        for k, v in FACTORS.items()}}


def rounded(obj, sig: int = 2):
    """Round floats to 2 significant figures for display / Gemini input."""
    if isinstance(obj, float):
        if obj == 0:
            return 0
        return round(obj, -int(math.floor(math.log10(abs(obj)))) + (sig - 1))
    if isinstance(obj, (list, tuple)):
        return [rounded(x, sig) for x in obj]
    if isinstance(obj, dict):
        return {k: rounded(v, sig) for k, v in obj.items()}
    return obj


if __name__ == "__main__":
    print(json.dumps(rounded(run_scenario(["stratos"])["totals"]), indent=2))
