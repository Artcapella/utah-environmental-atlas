"""Build the atlas assistant's knowledge index.

    python scripts/atlas/build_knowledge.py            # documents + embeddings (reuses unchanged vectors)
    python scripts/atlas/build_knowledge.py --no-embed # documents only (keyword search)
    python scripts/atlas/build_knowledge.py --check    # exit 1 if the shipped index is stale

Writes backend/atlas/data/knowledge.json and knowledge_vectors.json. Run it after changing the
source catalog, the project registry, the bill library, the permit pipeline or the research notes.
Embeddings use OpenAI (OPENAI_API_KEY, else AI_GATEWAY_API_KEY) and fall back to Gemini.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.atlas import knowledge as kn, llm  # noqa: E402


def shipped_digests() -> dict[str, str]:
    if not kn.KNOWLEDGE_FILE.exists():
        return {}
    return {d["id"]: kn.Doc(**d).digest for d in json.loads(kn.KNOWLEDGE_FILE.read_text(encoding="utf-8"))["docs"]}


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-embed", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    docs = kn.build_documents()
    fresh = {d.id: d.digest for d in docs}
    if args.check:
        stale = fresh != shipped_digests()
        print("knowledge.json is STALE; run scripts/atlas/build_knowledge.py" if stale else f"knowledge.json is current ({len(docs)} documents)")
        return 1 if stale else 0

    kn.DATA.mkdir(parents=True, exist_ok=True)
    kn.KNOWLEDGE_FILE.write_text(json.dumps({"built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                             "docs": kn.dump_documents(docs)}, ensure_ascii=False, indent=1), encoding="utf-8")
    kinds: dict[str, int] = {}
    for d in docs:
        kinds[d.kind] = kinds.get(d.kind, 0) + 1
    print(f"Wrote {len(docs)} documents: {kinds}")
    if args.no_embed:
        return 0

    tags = llm.available_embedding_tags()
    if not tags:
        print("No embedding credentials (OPENAI_API_KEY, AI_GATEWAY_API_KEY or GEMINI_API_KEY); search stays keyword-only.")
        return 0
    old = json.loads(kn.VECTORS_FILE.read_text(encoding="utf-8")) if kn.VECTORS_FILE.exists() else {}
    for tag in tags:
        kept = {i: item for i, item in old.get("items", {}).items() if old.get("tag") == tag and fresh.get(i) == item.get("h")}
        todo = [d for d in docs if d.id not in kept]
        result = await llm.embed([d.embed_text() for d in todo], tag, timeout=120.0, patient=True) if todo else ([], tag)
        if result is None:
            print(f"Embedding with {tag} failed; trying the next provider.")
            continue
        for d, v in zip(todo, result[0], strict=True):
            kept[d.id] = {"h": d.digest, "v": [round(x, 5) for x in v]}
        kn.VECTORS_FILE.write_text(json.dumps({"tag": tag, "items": {d.id: kept[d.id] for d in docs}}, separators=(",", ":")),
                                   encoding="utf-8")
        print(f"Embedded {len(todo)} documents with {tag} ({len(docs) - len(todo)} reused).")
        return 0
    print("Every embedding provider failed; search stays keyword-only until this is re-run.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
