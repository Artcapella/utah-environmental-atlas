"""Atlas assistant: knowledge index, bill library, branch comparison, map actions and the answer chain.

conftest.py clears every model key, so these run offline on the local (quoted-sources) path unless a
test fakes a model.
"""
import asyncio
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.atlas import assistant as A, knowledge as kn
from backend.atlas.bills import BILLS, merge_levers
from backend.atlas.comparison import compare_branches
from backend.atlas.engine import BRANCHES, Levers
from backend.atlas.router import router
from backend.config import settings

ROOT = Path(__file__).resolve().parents[1]


def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_shipped_knowledge_index_is_current() -> None:
    shipped = {d["id"]: kn.Doc(**d).digest for d in json.loads(kn.KNOWLEDGE_FILE.read_text(encoding="utf-8"))["docs"]}
    fresh = {d.id: d.digest for d in kn.build_documents()}
    assert shipped == fresh, "run: python scripts/atlas/build_knowledge.py"


def test_knowledge_covers_every_kind_of_source_and_hides_placeholder_numbers() -> None:
    docs = kn.build_documents()
    assert {d.kind for d in docs} >= {"source", "project", "figure", "permit", "basin", "bill", "factor", "comparison", "context", "research", "app"}
    assert len([d for d in docs if d.kind == "source"]) >= 70
    basin = json.loads((ROOT / "public/atlas/data/basin_risk.json").read_text(encoding="utf-8"))
    for d in (d for d in docs if d.kind == "basin"):
        assert d.placeholder and (d.id == "basin:lenses" or "placeholder" in d.text)
        for b in basin["basins"]:   # invented baselines must never be quotable
            assert f"{b['headroom']:,}" not in d.text and str(b["headroom"]) not in d.text
    figure = next(d for d in docs if d.id.startswith("figure:stratos") and "987" in d.text)
    assert figure.source_type == "dev" and figure.verified is False


def test_keyword_search_finds_the_right_documents() -> None:
    index = kn.Index(kn.build_documents())
    top = lambda q: [h.doc.id for h in index.search(q, 5)]
    assert "bill:hb76_2026" in top("what does H.B. 76 do")
    assert "source:water-rights-points-of-diversion" in top("junior rights priority date dataset")
    assert any(i.startswith("comparison:stratos:air_health") for i in top("premature deaths from air pollution"))
    assert index.search("stratos", 3, kinds={"permit"})[0].doc.kind == "permit"


def test_bill_library_maps_onto_engine_levers() -> None:
    ids = {b["id"] for b in BILLS}
    assert {"hb76_2026", "hb60_2026", "eo_2026_03", "iron_2026_13", "mock_dry_cooling"} <= ids
    for b in BILLS:
        Levers(**b["levers"])
        assert b["real"] or "not real legislation" in b["status"].lower()
        assert b["map_effect"] and b["basis"]
    assert merge_levers(["iron_2026_13", "cache_2026_32", "hb76_2026"]) == {"moratorium_counties": ["Iron", "Cache"], "reporting_threshold_af": 75}
    assert len(client().get("/api/atlas/bills").json()) == len(BILLS)


def test_four_branch_comparison_never_reports_zero_for_unknowns() -> None:
    comp = compare_branches("stratos")
    assert [b["id"] for b in comp["branches"]] == list(BRANCHES) and comp["conditions_default"]
    by = {b["id"]: b for b in comp["branches"]}
    assert by["conditions"]["water_af"][1] < by["scaled"]["water_af"][1] < by["built"]["water_af"][1]
    assert by["not_built"]["water_af"] is None
    rows = {r["id"]: r for r in comp["rows"]}
    assert "unknown, not zero" in rows["water"]["cells"]["not_built"][0]["note"]
    health = rows["air_health"]["cells"]["built"]
    assert any(c["tags"] == ["adv"] and "5 to 45" in c["text"] for c in health)
    assert rows["heat"]["cells"]["conditions"][0]["kind"] == "nq"
    assert any("net score" in x for x in comp["limits"])
    assert client().post("/api/atlas/compare", json={"project_id": "nope"}).status_code == 404
    other = client().post("/api/atlas/compare", json={"project_id": "joule"}).json()
    assert other["has_published"] is False and other["rows"][0]["cells"]["built"][0]["kind"] == "engine"


def test_actions_are_validated_against_closed_lists() -> None:
    done = A.clean_actions([
        {"type": "apply_bill", "bill_id": "mock_dry_cooling"}, {"type": "apply_bill", "bill_id": "made_up"},
        {"type": "select_projects", "ids": ["stratos", "nope"]}, {"type": "set_layer", "id": "evil-layer", "on": True},
        {"type": "set_levers", "levers": {"hack": 1}}, {"type": "fly_to", "lat": 10, "lng": 10},
        {"type": "fly_to", "place": "great_salt_lake"}, {"type": "run_script", "code": "alert(1)"}, "junk",
    ])
    assert [a["type"] for a in done] == ["apply_bill", "select_projects", "fly_to"]
    assert done[1]["ids"] == ["stratos"] and all(a["label"] for a in done)


def test_intent_rules_move_the_map() -> None:
    kinds = lambda q: [a["type"] for a in A.heuristic_actions(q, None)]
    assert kinds("Show me around") == ["start_tour"]
    acts = A.heuristic_actions("What would H.B. 76 do to Stratos?", None)
    assert {"type": "apply_bill", "bill_id": "hb76_2026", "label": "Applied H.B. 76 (2026) to the map"} in acts
    assert any(a["type"] == "select_projects" and a["ids"] == ["stratos"] for a in acts)
    assert "open_compare" in kinds("compare the branches for Joule")
    assert kinds("thanks") == []


def test_ask_answers_offline_from_sources_and_the_engine() -> None:
    r = client().post("/api/atlas/ask", json={"query": "What would the dry cooling bill do to Stratos?",
                                              "app": {"selected": ["stratos"]}}).json()
    assert r["agent"] == "local_fallback" and r["retrieval"] == "keyword" and r["grounded"]
    assert "about 2,000 AF/yr" in r["answer"] and "40,000" in r["answer"] and "estimates, not measurements" in r["answer"]
    labels = {c["label"] for c in r["citations"]}
    assert labels and all(f"[{label}]" in r["answer"] for label in labels)
    assert any(c["source_type"] == "der" and c["source_name"].startswith("Atlas impact engine") for c in r["citations"])
    assert [a["type"] for a in r["actions"]].count("apply_bill") == 1
    tour = client().post("/api/atlas/ask", json={"query": "show me around"}).json()
    assert tour["actions"][0]["type"] == "start_tour"


def test_gemini_path_runs_tools_guards_numbers_and_returns_actions(monkeypatch) -> None:
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    part = lambda **kw: {"candidates": [{"finishReason": "STOP", "content": {"role": "model", "parts": [kw]}}]}
    replies = iter([
        part(functionCall={"name": "run_impact_scenario", "args": {"project_ids": ["stratos"], "bill_ids": ["mock_dry_cooling"]}}),
        part(functionCall={"name": "show_in_app", "args": {"actions": [{"type": "apply_bill", "bill_id": "mock_dry_cooling"}]}}),
        part(text="Water would fall to about 1,234 AF/yr [S9]."),                      # 1,234 is invented
        part(text="Water would be about 2,000 AF/yr (range 0 to 12,000) [S9]."),
    ])
    seen = []

    async def fake_generate(client, model, body):
        seen.append(body)
        return next(replies)

    monkeypatch.setattr(A.env, "_generate", fake_generate)
    r = asyncio.run(A.ask(A.AskRequest(query="What would the dry cooling bill do to Stratos?")))
    assert r.agent == "gemini" and r.grounded and "2,000" in r.answer and "1,234" not in r.answer
    assert [a["type"] for a in r.actions] == ["apply_bill"]
    assert "1,234" in seen[3]["contents"][-1]["parts"][0]["text"]       # the guard asked for a rewrite
    names = {d["name"] for d in seen[0]["tools"][0]["functionDeclarations"]}
    assert {"search_atlas_sources", "run_impact_scenario", "show_in_app", "get_air_quality"} <= names
    assert "decision support, not advocacy" in seen[0]["systemInstruction"]["parts"][0]["text"]


def test_openai_backup_uses_the_gateway_when_no_direct_key(monkeypatch) -> None:
    monkeypatch.setattr(settings, "ai_gateway_api_key", "gw-key")
    assert settings.openai_route == ("https://ai-gateway.vercel.sh/v1", "gw-key", "openai/")
    calls = {}

    async def fake_chat(system, user, **kw):
        calls["user"] = user
        return "The engine estimates about 40,000 AF/yr (range 0 to 230,000) [S1]."

    monkeypatch.setattr(A.llm, "openai_chat", fake_chat)
    r = asyncio.run(A.ask(A.AskRequest(query="How much water would Stratos use?", app=A.AppState(selected=["stratos"]))))
    assert r.agent == "openai" and r.grounded and "Atlas impact engine result" in calls["user"]
    monkeypatch.setattr(settings, "openai_api_key", "direct")
    assert settings.openai_route == ("https://api.openai.com/v1", "direct", "")


def test_assistant_assets_are_wired_into_the_map() -> None:
    assets = ROOT / "public" / "assets"
    for name in ("atlas-extras.js", "atlas-compare.js"):
        assert (assets / name).is_file(), name
    assert "installExtras(ImpactPanel)" in (assets / "atlas-panel.js").read_text(encoding="utf-8")
    assert "window.YOUtahAtlas" in (assets / "map-atlas.js").read_text(encoding="utf-8")
    guide = (assets / "map-guide.js").read_text(encoding="utf-8")
    assert "/api/atlas/ask" in guide and "YOUtahAtlas.run" in guide
    status = client().get("/api/atlas/ask/status").json()
    assert status["documents"] > 150 and "gemini_configured" in status and "key" not in json.dumps(status).lower()
