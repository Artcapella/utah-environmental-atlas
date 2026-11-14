"""Ping every URL in scripts/atlas/sources.json and report which respond. Run before a demo.

    python scripts/check_sources.py              # all
    python scripts/check_sources.py tiles api    # by kind
    FIRMS_MAP_KEY=xxxx python scripts/check_sources.py

Tile templates are tested with a Utah tile (z6/x12/y24) and its 3857 bbox.
Writes scripts/atlas/sources_status.json; set "verified": true by hand once a source is confirmed usable.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
UTAH_TILE = {"{z}": "6", "{x}": "12", "{y}": "24",
             "{bbox-epsg-3857}": "-12523442.7,4383204.9,-11897270.6,5009377.1"}


def fill(url: str) -> str:
    for k, v in UTAH_TILE.items():
        url = url.replace(k, v)
    return url.replace("{MAP_KEY}", os.environ.get("FIRMS_MAP_KEY", "MISSING_KEY"))


def check(src: dict) -> dict:
    url = fill(src["url"])
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "YOUtah-source-check"})
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read(512)
            ctype = r.headers.get("Content-Type", "")
            ok = r.status == 200 and (src["kind"] != "tiles" or ctype.startswith("image"))
            return {**src, "status": r.status, "content_type": ctype, "ok": ok,
                    "hint": "" if ok else body[:120].decode(errors="replace")}
    except Exception as e:
        return {**src, "status": None, "ok": False, "hint": str(e)[:160]}


if __name__ == "__main__":
    sources = json.loads((ROOT / "sources.json").read_text())
    kinds = set(sys.argv[1:])
    sources = [s for s in sources if not kinds or s["kind"] in kinds]
    with ThreadPoolExecutor(12) as ex:
        res = list(ex.map(check, sources))
    for r in sorted(res, key=lambda r: (r["ok"], r["category"])):
        print(f"{'OK  ' if r['ok'] else 'FAIL'} {str(r['status'] or '-'):>4} {r['kind']:8} {r['name'][:60]:60} {r['hint'][:60]}")
    (ROOT / "sources_status.json").write_text(json.dumps(res, indent=1))
    print(f"\n{sum(r['ok'] for r in res)}/{len(res)} reachable")
