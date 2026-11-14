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
