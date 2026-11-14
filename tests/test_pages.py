import json
from pathlib import Path

from fastapi.testclient import TestClient

from app import app

ROOT = Path(__file__).resolve().parents[1]


def test_map_page_is_served_locally() -> None:
    response = TestClient(app).get("/map")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert 'id="map"' in response.text


def test_vercel_rewrites_map_to_static_page() -> None:
    config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
    rewrite = {"source": "/map", "destination": "/map.html"}
    assert rewrite in config.get("rewrites", [])
    assert (ROOT / "public" / "map.html").is_file()


def test_home_page_is_the_map_with_climate_layers_and_the_assistant() -> None:
    html = TestClient(app).get("/").text
    assert 'id="map"' in html
    for asset in ("/assets/map-climate.js", "/assets/map-guide.js", "/assets/env-charts.js", "/assets/guide-renderer.js"):
        assert asset in html
    # plug-ins load after the map core (they use window.YOUtah) and charts before the climate module
    tag = lambda name: html.index(f'<script src="/assets/{name}"')
    assert tag("map-live-inversion.js") < tag("env-charts.js") < tag("map-climate.js") < tag("map-guide.js")
    for asset in ("map-climate.js", "map-climate.css", "map-guide.js", "env-charts.js", "env-charts.css", "guide-renderer.js"):
        assert (ROOT / "public" / "assets" / asset).is_file(), asset


def test_vercel_serves_the_map_at_home_and_retires_the_simple_view() -> None:
    config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
    assert {"source": "/", "destination": "/map.html"} in config.get("rewrites", [])
    assert {"source": "/about", "destination": "/about.html"} in config.get("rewrites", [])
    assert {"source": "/map/simple", "destination": "/", "permanent": True} in config.get("redirects", [])
    # A file at public/index.html would win over the "/" rewrite on Vercel.
    assert not (ROOT / "public" / "index.html").exists()
    assert not (ROOT / "public" / "map-simple.html").exists()


def test_old_simple_map_links_redirect_home_and_about_keeps_the_landing_page() -> None:
    client = TestClient(app)
    redirect = client.get("/map/simple", follow_redirects=False)
    assert redirect.status_code == 308 and redirect.headers["location"] == "/"
    assert 'id="trend-chart"' in client.get("/about").text


def test_no_page_links_to_the_retired_simple_view() -> None:
    for page in (ROOT / "public").glob("*.html"):
        assert "/map/simple" not in page.read_text(encoding="utf-8"), page.name


def test_promoters_page_is_served_with_a_promotion_form() -> None:
    response = TestClient(app).get("/promoters")
    assert response.status_code == 200
    assert 'id="promotion-form"' in response.text
    assert 'name="cadence"' in response.text


def test_map_nav_link_stays_visible_on_narrow_screens() -> None:
    css = (ROOT / "public" / "assets" / "styles.css").read_text(encoding="utf-8")
    assert ".nav-links { display:none; }" not in css
    assert ".nav-links a:not(.nav-map) { display:none; }" in css


def test_pages_run_in_environmental_mode_with_tourist_ui_hidden() -> None:
    css = (ROOT / "public" / "assets" / "env-mode.css").read_text(encoding="utf-8")
    assert ".env-mode .tourist" in css
    for page in ("about.html", "map.html", "inversion.html"):
        html = (ROOT / "public" / page).read_text(encoding="utf-8")
        assert '<body class="env-mode">' in html, page
        assert "/assets/env-mode.css" in html, page
        assert not re_promoter_link_visible(html), page


def re_promoter_link_visible(html: str) -> bool:
    import re
    return any("tourist" not in tag for tag in re.findall(r'<a[^>]*href="/promoters"[^>]*>', html))


def test_map_mounts_the_environmental_atlas() -> None:
    html = (ROOT / "public" / "map.html").read_text(encoding="utf-8")
    assert 'data-tab="impact"' in html and 'id="tab-impact"' in html
    assert '<script type="module" src="/assets/map-atlas.js"></script>' in html
    assert "/assets/atlas-panel.css" in html and "{ id:'atlas'" in html
    assert html.index("/assets/map-guide.js") < html.index("/assets/map-atlas.js")
    for asset in ("map-atlas.js", "atlas-layers.js", "atlas-panel.js", "atlas-panel.css", "atlas-basin-risk.js"):
        assert (ROOT / "public" / "assets" / asset).is_file(), asset


def test_atlas_static_layers_ship_and_are_not_gitignored() -> None:
    data = ROOT / "public" / "atlas" / "data"
    for name in ("projects.geojson", "permits.geojson", "basin_risk.json", "context.json", "manifest.json",
                 "utah_counties.geojson", "gsl_reference.geojson", "gsl_playa_scenarios.geojson"):
        assert (data / name).is_file(), name
    assert (ROOT / "backend" / "atlas" / "data" / "gsl_reference.geojson").is_file()
    # A bare "data/" rule matches at any depth and would keep the atlas layers out of git-based deploys.
    rules = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert "data/" not in [r.strip() for r in rules], "anchor the root data folder as /data/"
    basin = json.loads((data / "basin_risk.json").read_text(encoding="utf-8"))
    assert basin["baseline_status"] == "placeholder" and "PLACEHOLDER" in basin["warning"]


def test_briefing_is_served_and_routed() -> None:
    client = TestClient(app)
    page = client.get("/briefing")
    assert page.status_code == 200 and 'id="levers"' in page.text and 'id="county"' in page.text
    assert client.get("/atlas/pilots/stratos_who_pays.html").status_code == 200
    assert client.get("/atlas/data/permits.geojson").status_code == 200
    config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
    assert {"source": "/briefing", "destination": "/atlas/briefing.html"} in config["rewrites"]


def test_water_screen_is_served_and_linked_from_the_map() -> None:
    client = TestClient(app)
    page = client.get("/screen?project=stratos")
    assert page.status_code == 200 and 'id="atlasProject"' in page.text and 'id="atlasCmp"' in page.text
    assert "from '/assets/atlas-screen.js'" in page.text
    assert client.get("/assets/atlas-screen.js").status_code == 200
    config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
    assert {"source": "/screen", "destination": "/atlas/water-screen.html"} in config["rewrites"]
    # The map hands a project to the screen from the Projects tab, dropped projects and the map popup.
    panel = (ROOT / "public" / "assets" / "atlas-panel.js").read_text(encoding="utf-8")
    assert "from './atlas-screen.js'" in panel and panel.count("this.screenLink(") >= 2
    assert "/screen?project=" in (ROOT / "public" / "assets" / "atlas-layers.js").read_text(encoding="utf-8")
    # One lake-need figure across the app: the screen reads the Atlas's, it does not carry its own.
    assert "700,000" not in page.text
