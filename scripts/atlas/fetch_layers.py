"""Fetch the live-source layers into public/atlas/data/ (run on a machine with normal internet).

    python scripts/atlas/fetch_layers.py all              # everything that needs no key
    python scripts/atlas/fetch_layers.py gbif tri basins  # pick steps
    FIRMS_MAP_KEY=xxxx python scripts/atlas/fetch_layers.py firms

Steps: gbif, habitat, firms, perimeters, tri, basins. Each step is independent; a failure
is logged and skipped (the engine's overlap rows ignore missing files). No dependencies
beyond the standard library, shapely and h3 (pip install shapely h3).
"""
from __future__ import annotations

import csv
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "public" / "atlas" / "data"
BBOX = (-114.053, 36.998, -109.041, 42.002)          # Utah
UA = {"User-Agent": "YOUtah-Environmental-Atlas/1.0"}


def get(url: str, params: dict | None = None, timeout: int = 60) -> bytes:
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def save(name: str, fc: dict, source: str) -> None:
    fc.setdefault("metadata", {}).update(
        {"source": source, "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    (OUT / name).write_text(json.dumps(fc, separators=(",", ":")))
    print(f"  wrote {name}: {len(fc['features'])} features")


def arcgis_query(layer_url: str, where: str = "1=1", out_fields: str = "*", page: int = 1000) -> dict:
    """Page through an ArcGIS FeatureServer/MapServer layer clipped to the Utah bbox."""
    feats, offset = [], 0
    env = ",".join(map(str, BBOX))
    while True:
        js = json.loads(get(layer_url.rstrip("/") + "/query", {
            "where": where, "outFields": out_fields, "geometry": env, "geometryType": "esriGeometryEnvelope",
            "inSR": 4326, "outSR": 4326, "spatialRel": "esriSpatialRelIntersects", "f": "geojson",
            "resultOffset": offset, "resultRecordCount": page}))
        batch = js.get("features", [])
        feats += batch
        if not batch or not (js.get("exceededTransferLimit") or js.get("properties", {}).get("exceededTransferLimit")):
            break
        offset += len(batch)
    return {"type": "FeatureCollection", "features": feats}


# ---------------------------------------------------------------- steps
def gbif(max_records: int = 20_000, res: int = 6) -> None:
    """Occurrences -> H3 hexes with record and species counts (no raw points, protects sensitive species)."""
    import h3
    from shapely.geometry import Polygon, mapping
    cells: dict[str, dict] = {}
    offset = 0
    while offset < max_records:
        js = json.loads(get("https://api.gbif.org/v1/occurrence/search", {
            "country": "US", "stateProvince": "Utah", "hasCoordinate": "true",
            "hasGeospatialIssue": "false", "limit": 300, "offset": offset}))
        for o in js.get("results", []):
            lat, lon = o.get("decimalLatitude"), o.get("decimalLongitude")
            if lat is None or lon is None:
                continue
            c = cells.setdefault(h3.latlng_to_cell(lat, lon, res), {"records": 0, "species": set()})
            c["records"] += 1
            if o.get("speciesKey"):
                c["species"].add(o["speciesKey"])
        if js.get("endOfRecords"):
            break
        offset += 300
        time.sleep(0.2)
    feats = []
    for cell, c in cells.items():
        ring = [(lng, lat) for lat, lng in h3.cell_to_boundary(cell)]
        feats.append({"type": "Feature", "geometry": mapping(Polygon(ring)),
                      "properties": {"h3": cell, "records": c["records"], "species": len(c["species"])}})
    save("gbif_hex.geojson", {"type": "FeatureCollection", "features": feats},
         f"GBIF occurrence API, first {max_records} Utah records, H3 res {res}")


def habitat() -> None:
    base = "https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/USFWS_Critical_Habitat/FeatureServer"
    meta = json.loads(get(base, {"f": "json"}))
    feats = []
    for lyr in meta.get("layers", []):
        info = json.loads(get(f"{base}/{lyr['id']}", {"f": "json"}))
        if info.get("geometryType") == "esriGeometryPolygon":
            feats += arcgis_query(f"{base}/{lyr['id']}")["features"]
    save("critical_habitat.geojson", {"type": "FeatureCollection", "features": feats}, base)


def firms(days: int = 7) -> None:
    key = os.environ.get("FIRMS_MAP_KEY")
    if not key:
        raise RuntimeError("set FIRMS_MAP_KEY (free at firms.modaps.eosdis.nasa.gov/api/map_key)")
    area = ",".join(map(str, BBOX))
    raw = get(f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/VIIRS_SNPP_NRT/{area}/{days}").decode()
    feats = [{"type": "Feature",
              "geometry": {"type": "Point", "coordinates": [float(r["longitude"]), float(r["latitude"])]},
              "properties": {k: r.get(k) for k in ("acq_date", "acq_time", "confidence", "frp", "daynight")}}
             for r in csv.DictReader(io.StringIO(raw))]
    save("firms_7d.geojson", {"type": "FeatureCollection", "features": feats}, f"NASA FIRMS VIIRS SNPP NRT, {days} days")


def perimeters(since_year: int = 2020) -> None:
    url = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters/FeatureServer/0"
    fc = arcgis_query(url, where=f"attr_FireDiscoveryDateTime >= DATE '{since_year}-01-01'",
                      out_fields="poly_IncidentName,attr_FireDiscoveryDateTime,poly_GISAcres")
    save("fire_perimeters.geojson", fc, url)


def tri() -> None:
    rows = json.loads(get("https://data.epa.gov/efservice/tri_facility/state_abbr/UT/JSON", timeout=120))
    feats = []
    for r in rows:
        lat = r.get("pref_latitude") or r.get("PREF_LATITUDE")
        lon = r.get("pref_longitude") or r.get("PREF_LONGITUDE")
        try:
            lat, lon = float(lat), float(lon)
        except (TypeError, ValueError):
            continue
        lon = -abs(lon)                      # some TRI rows drop the western-hemisphere sign
        if not (BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]):
            continue
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                      "properties": {"name": r.get("facility_name") or r.get("FACILITY_NAME"),
                                     "tri_id": r.get("tri_facility_id") or r.get("TRI_FACILITY_ID")}})
    save("tri_facilities.geojson", {"type": "FeatureCollection", "features": feats}, "EPA Envirofacts TRI")


# Keyword crosswalk HUC8 name -> briefing basin (matches impact_engine basin labels). Review after fetching.
BASIN_KEYWORDS = [
    ("Bear River / GSL", ["bear", "malad", "great salt lake", "hansel", "curlew", "blue creek"]),
    ("Utah Lake / Jordan", ["jordan", "utah lake", "provo", "spanish fork"]),
    ("Weber", ["weber", "ogden"]),
    ("Sevier River", ["sevier", "san pitch", "juab"]),
    ("Cedar/Beaver", ["beaver", "escalante desert", "cedar"]),
    ("Uinta (Colorado River)", ["duchesne", "uinta", "strawberry", "price", "white", "green"]),
    ("West Desert", ["great salt lake desert", "tooele", "rush", "skull", "dugway", "snake valley", "pine valley"]),
    ("Virgin / Kanab", ["virgin", "kanab", "fort pierce"]),
    ("Colorado / San Juan", ["colorado", "san juan", "dirty devil", "escalante river", "fremont", "muddy", "paria"]),
]


def basins() -> None:
    fc = arcgis_query("https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer/4", out_fields="huc8,name")
    for f in fc["features"]:
        name = (f["properties"].get("name") or "").lower()
        f["properties"]["basin"] = next((b for b, kws in BASIN_KEYWORDS if any(k in name for k in kws)), "Unassigned")
        f["properties"]["baseline_status"] = "placeholder"
    save("wbd_huc8.geojson", fc, "USGS WBD HUC8 (MapServer layer 4); basin = keyword crosswalk")


STEPS = {"gbif": gbif, "habitat": habitat, "firms": firms, "perimeters": perimeters, "tri": tri, "basins": basins}

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    want = sys.argv[1:] or ["all"]
    names = [s for s in STEPS if s != "firms" or os.environ.get("FIRMS_MAP_KEY")] if want == ["all"] else want
    failed = []
    for n in names:
        print(f"[{n}]")
        try:
            STEPS[n]()
        except Exception as e:                     # keep going; report at the end
            print(f"  FAILED: {e}")
            failed.append(n)
    print("done" if not failed else f"done, failed: {failed} (check scripts/atlas/sources.json URLs)")
