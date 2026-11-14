"""Turn engine results into map-ready GeoJSON overlays.

Used by scripts/atlas/build_static_layers.py (static files) and POST /api/atlas/overlays (live).
Shapely (>=2) is needed only for polygon work (playa band, counties, wind wedge); project points
are plain GeoJSON so /api/atlas/overlays still answers if shapely is missing from a deployment.
"""
from __future__ import annotations

import math
try:
    from shapely.geometry import Polygon, mapping, shape
    from shapely.ops import transform
    HAVE_SHAPELY = True
except ImportError:  # pragma: no cover - exercised only on deployments without shapely
    HAVE_SHAPELY = False

M_PER_DEG_LAT = 110_540
ACRE_M2 = 4046.86


def _proj(lon0: float, lat0: float):
    k = 111_320 * math.cos(math.radians(lat0))
    fwd = lambda x, y, z=None: ((x - lon0) * k, (y - lat0) * M_PER_DEG_LAT)
    inv = lambda x, y, z=None: (x / k + lon0, y / M_PER_DEG_LAT + lat0)
    return fwd, inv


def _round(geom, nd=5):
    return transform(lambda x, y, z=None: (round(x, nd), round(y, nd)), geom)


def fc(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}


def feature(geom, props: dict) -> dict:
    return {"type": "Feature", "geometry": mapping(_round(geom)), "properties": props}


def point_feature(lon: float, lat: float, props: dict) -> dict:
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
            "properties": props}


# ---------------------------------------------------------------- GSL playa band
def playa_band(lake_geojson_geom: dict, playa_acres: float, max_km: float = 40) -> dict | None:
    """Inward band of the reference lake outline whose area equals `playa_acres`.

    ILLUSTRATIVE: real exposure follows bathymetry, not a uniform inward buffer.
    Returns {"band": geom, "remaining": geom, "width_m": float} in lon/lat.
    """
    if playa_acres <= 0 or not HAVE_SHAPELY:
        return None
    lake = shape(lake_geojson_geom)
    c = lake.centroid
    fwd, inv = _proj(c.x, c.y)
    lake_m = transform(fwd, lake)
    target = playa_acres * ACRE_M2
    if target >= lake_m.area:
        return {"band": lake, "remaining": Polygon(), "width_m": None}
    lo, hi = 0.0, max_km * 1000
    for _ in range(40):
        mid = (lo + hi) / 2
        if lake_m.area - lake_m.buffer(-mid).area < target:
            lo = mid
        else:
            hi = mid
    remaining = lake_m.buffer(-hi)
    band = lake_m.difference(remaining)
    return {"band": transform(inv, band), "remaining": transform(inv, remaining), "width_m": hi}


# ---------------------------------------------------------------- projects
def projects_fc(result: dict, registry: dict) -> dict:
    feats = []
    for r in result["projects"]:
        p = registry.get(r["project"])
        if p is None:
            continue
        props = {"id": p.id, "name": p.name, "county": p.county, "basin": p.basin, "mw": p.mw,
                 "status": p.status, "gsl_basin": p.gsl_basin, "coords_approx": p.coords_approx,
                 "not_built": bool(r.get("not_built"))}
        if "water_af" in r:
            w = r["water_af"]
            props.update({
                "water_low": w["total"][0], "water_central": w["total"][1], "water_high": w["total"][2],
                "stated_af": w["stated"], "rights_af": w["rights"], "published_high_af": w["published_high"],
                "co2_central_tons": r["air_tons"]["co2"][1], "nox_central_tons": r["air_tons"]["nox"][1],
                "eo_test": w["eo_2026_03_test"],
            })
            if r.get("reporting_visible") is not None:   # a reporting-threshold lever is set
                props["would_report"] = bool(r["reporting_visible"])
        feats.append(point_feature(p.lon, p.lat, props))
    return fc(feats)


# ---------------------------------------------------------------- counties
def counties_fc(counties: dict, result: dict, registry: dict) -> dict:
    by = {}
    for r in result["projects"]:
        p = registry.get(r["project"])
        if p is None or "water_af" not in r:
            continue
        d = by.setdefault(p.county.lower(), {"n": 0, "central": 0.0, "stated": 0.0})
        d["n"] += 1
        d["central"] += r["water_af"]["total"][1]
        d["stated"] += r["water_af"]["stated"] or 0
    out = []
    for f in counties["features"]:
        name = f["properties"]["NAME"]
        d = by.get(name.lower(), {"n": 0, "central": 0.0, "stated": 0.0})
        out.append(feature(shape(f["geometry"]), {
            "name": name, "fips": "49" + f["properties"]["COUNTY"],
            "projects": d["n"], "water_central_af": round(d["central"]), "stated_af": round(d["stated"], 1)}))
    return fc(out)


# ---------------------------------------------------------------- air wedge
def wind_wedge(lon: float, lat: float, wind_from_deg: float, length_km: float = 60,
               half_angle: float = 20, props: dict | None = None) -> dict:
    """Downwind sector for a site. Pass wind direction from your NWS provider; no default is assumed."""
    fwd, inv = _proj(lon, lat)
    to = math.radians((wind_from_deg + 180) % 360)
    pts = [(0, 0)]
    for a in range(-int(half_angle), int(half_angle) + 1, 4):
        t = to + math.radians(a)
        pts.append((math.sin(t) * length_km * 1000, math.cos(t) * length_km * 1000))
    return feature(transform(inv, Polygon(pts)), props or {})
