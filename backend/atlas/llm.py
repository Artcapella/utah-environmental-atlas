"""Model plumbing for the atlas assistant: embeddings and the OpenAI backup answerer.

Embeddings: OpenAI text-embedding-3-small (direct key, else the Vercel AI Gateway), falling back to
Gemini embeddings. An index remembers which family built it (`tag`), because query and document
vectors must come from the same model; a mismatch or an outage degrades to keyword search.

Keys are sent only in request headers and never logged or returned.
"""
from __future__ import annotations

import asyncio
import logging

import httpx

from backend.config import settings

logger = logging.getLogger(__name__)
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
EMBED_BATCH = 64


def openai_tag() -> str:
    return f"openai:{settings.openai_embedding_model}:{settings.atlas_embedding_dimensions}"


def gemini_tag() -> str:
    return f"gemini:{settings.gemini_embedding_model}:{settings.atlas_embedding_dimensions}"


def available_embedding_tags() -> list[str]:
    """Embedding families this deployment has credentials for, preferred first."""
    tags = []
    if settings.openai_route:
        tags.append(openai_tag())
    if settings.gemini_api_key:
        tags.append(gemini_tag())
    return tags


async def _embed_openai(client: httpx.AsyncClient, texts: list[str]) -> list[list[float]]:
    base, key, prefix = settings.openai_route  # type: ignore[misc]
    out: list[list[float]] = []
    for i in range(0, len(texts), EMBED_BATCH):
        r = await client.post(f"{base}/embeddings", headers={"Authorization": f"Bearer {key}"},
                              json={"model": prefix + settings.openai_embedding_model, "input": texts[i:i + EMBED_BATCH],
                                    "dimensions": settings.atlas_embedding_dimensions})
        r.raise_for_status()
        out += [item["embedding"] for item in sorted(r.json()["data"], key=lambda item: item["index"])]
    return out


async def _embed_gemini(client: httpx.AsyncClient, texts: list[str], query: bool, patient: bool = False) -> list[list[float]]:
    """`patient` (index builds only): wait out the free tier's per-minute embedding limit instead of failing."""
    model = f"models/{settings.gemini_embedding_model}"
    out: list[list[float]] = []
    batch = 40 if patient else EMBED_BATCH
    for i in range(0, len(texts), batch):
        body = {"requests": [{"model": model, "content": {"parts": [{"text": t}]},
                              "taskType": "RETRIEVAL_QUERY" if query else "RETRIEVAL_DOCUMENT",
                              "outputDimensionality": settings.atlas_embedding_dimensions} for t in texts[i:i + batch]]}
        for attempt in range(6):
            r = await client.post(f"{GEMINI_BASE_URL}/{model}:batchEmbedContents",
                                  headers={"x-goog-api-key": settings.gemini_api_key}, json=body)
            if r.status_code != 429 or not patient or attempt == 5:
                break
            logger.info("Gemini embedding rate limit reached; waiting a minute (%s of %s done)", i, len(texts))
            await asyncio.sleep(62)
        r.raise_for_status()
        out += [item["values"] for item in r.json()["embeddings"]]
    return out


async def embed(texts: list[str], tag: str | None = None, *, query: bool = False, timeout: float = 20.0,
                patient: bool = False) -> tuple[list[list[float]], str] | None:
    """Embed `texts` with the family named by `tag` (or the first available). None when it cannot."""
    if not texts:
        return None
    for candidate in ([tag] if tag else available_embedding_tags()):
        if candidate not in available_embedding_tags():
            continue
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
                if candidate.startswith("openai:"):
                    return await _embed_openai(client, texts), candidate
                return await _embed_gemini(client, texts, query, patient), candidate
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as error:
            status = getattr(getattr(error, "response", None), "status_code", "")
            logger.info("Atlas embeddings via %s unavailable (%s %s)", candidate.split(":")[0], type(error).__name__, status)
    return None


async def openai_chat(system: str, user: str, *, max_tokens: int = 900, timeout: float = 30.0) -> str | None:
    """One OpenAI chat completion (direct or through the gateway). None on any failure."""
    route = settings.openai_route
    if not route:
        return None
    base, key, prefix = route
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            r = await client.post(f"{base}/chat/completions", headers={"Authorization": f"Bearer {key}"},
                                  json={"model": prefix + settings.openai_model, "max_completion_tokens": max_tokens,
                                        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]})
            r.raise_for_status()
            text = r.json()["choices"][0]["message"]["content"]
        return text.strip() if isinstance(text, str) and text.strip() else None
    except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as error:
        status = getattr(getattr(error, "response", None), "status_code", "")
        logger.info("Atlas OpenAI answer unavailable (%s %s)", type(error).__name__, status)
        return None
