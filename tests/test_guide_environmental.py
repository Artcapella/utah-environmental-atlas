"""Environmental mode routes to the Gemini tool agent without any real network calls."""

import asyncio

from backend.config import settings
from backend.guide import environmental, service
from backend.guide.schemas import GuideAnswerRequest


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def test_environmental_mode_runs_tools_and_returns_cited_gemini_answer(monkeypatch) -> None:
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    bodies = []
    replies = iter([
        {"candidates": [{"content": {"role": "model", "parts": [
            {"functionCall": {"name": "get_air_quality", "args": {"lat": 99, "lng": -111.9}, "id": "c1"},
             "thoughtSignature": "sig"},
        ]}}]},
        {"candidates": [{"finishReason": "STOP", "content": {"role": "model", "parts": [
            {"text": "Air is Good, AQI 20 [S1, S9]."},
        ]}}]},
    ])

    async def fake_post(self, url, headers=None, json=None):
        assert headers == {"x-goog-api-key": "test-key"}
        assert "key=" not in url
        bodies.append(json)
        return _FakeResponse(next(replies))

    seen = {}

    async def fake_air(run, args):
        point = run.point(args)
        seen["lat"] = point.lat
        label = run.cite("Hawthorne air monitor", "Utah DAQ", "https://air.utah.gov/csvFeed.php?id=slc", "advisory")
        return {"source_label": label, "aqi": 20}

    monkeypatch.setattr("httpx.AsyncClient.post", fake_post)
    monkeypatch.setitem(environmental.TOOLS, "get_air_quality", fake_air)

    response = asyncio.run(service.answer_guide(GuideAnswerRequest(query="How is the air?", mode="environmental")))

    assert response.agent == "gemini"
    assert response.retrieval == "tools"
    assert seen["lat"] == 43.0  # model coordinates are clamped to Utah
    # Grouped labels are split, and an unknown label (S9) is removed rather than left dangling.
    assert response.answer == "Air is Good, AQI 20 [S1] ."
    assert [citation.label for citation in response.citations] == ["S1"]
    # The model turn (with its thought signature) is echoed back before the tool result.
    second = bodies[1]["contents"]
    assert second[1]["parts"][0]["thoughtSignature"] == "sig"
    assert second[2]["parts"][0]["functionResponse"] == {"name": "get_air_quality", "id": "c1",
                                                          "response": {"source_label": "S1", "aqi": 20}}


def test_environmental_mode_falls_back_when_gemini_is_not_configured(monkeypatch) -> None:
    monkeypatch.setattr(settings, "gemini_api_key", "")
    monkeypatch.setattr(settings, "openai_api_key", "")

    async def retrieve(*_args):
        return [], "fallback"

    async def unavailable(run, args):
        raise RuntimeError("offline")

    monkeypatch.setattr(service, "retrieve", retrieve)
    # Keep the test offline: the tools-only fallback finds no live data and defers to the local answer.
    monkeypatch.setitem(environmental.TOOLS, "get_air_quality", unavailable)
    monkeypatch.setitem(environmental.TOOLS, "get_inversion_status", unavailable)
    response = asyncio.run(service.answer_guide(GuideAnswerRequest(query="How is the air?", mode="environmental")))
    assert response.agent == "local_fallback"


def test_tool_failures_become_unavailable_results(monkeypatch) -> None:
    async def broken(run, args):
        raise RuntimeError("upstream down")

    monkeypatch.setitem(environmental.TOOLS, "get_weather", broken)
    run = environmental._Run(lat=40.76, lng=-111.89)
    part = asyncio.run(environmental._execute(run, {"name": "get_weather", "args": {}}))
    assert part["functionResponse"]["response"]["available"] is False


def test_busy_primary_model_falls_back_to_the_next(monkeypatch) -> None:
    import httpx

    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "gemini_model", "primary")
    monkeypatch.setattr(settings, "gemini_fallback_models_raw", "backup")
    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(environmental.asyncio, "sleep", no_wait)
    called = []

    async def fake_generate(client, model, body):
        called.append(model)
        if model == "primary":
            request = httpx.Request("POST", "https://example.test")
            raise httpx.HTTPStatusError("busy", request=request, response=httpx.Response(503, request=request))
        return {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "Clean air."}]}}]}

    monkeypatch.setattr(environmental, "_generate", fake_generate)
    result = asyncio.run(environmental.answer_environmental(GuideAnswerRequest(query="air?", mode="environmental")))
    assert called == ["primary", "primary", "backup"]
    assert result == ("Clean air.", [])
