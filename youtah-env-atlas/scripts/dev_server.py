"""Local dev server: API + static layers + frontend, no YOUtah needed.

    pip install -r requirements-atlas.txt
    python scripts/dev_server.py            # http://localhost:8000/atlas/demo.html
                                            # http://localhost:8000/atlas/briefing.html
                                            # http://localhost:8000/atlas/pilots/stratos_who_pays.html
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import uvicorn                                         # noqa: E402
from fastapi import FastAPI                            # noqa: E402
from fastapi.staticfiles import StaticFiles            # noqa: E402
from backend.routes.atlas_impact import router         # noqa: E402

app = FastAPI(title="YOUtah Environmental Atlas (dev)")
app.include_router(router)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
app.mount("/atlas", StaticFiles(directory=ROOT / "frontend" / "atlas", html=True), name="atlas")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]) if len(sys.argv) > 1 else 8000)
