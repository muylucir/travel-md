"""Custom node functions for the Planning Orchestrator DAG.

Each node is implemented as a ``MultiAgentBase`` subclass so it can be
plugged into Strands ``GraphBuilder`` as a custom node.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time

from strands.agent.agent_result import AgentResult
from strands.multiagent.base import MultiAgentBase, MultiAgentResult, NodeResult, Status
from strands.types.content import ContentBlock, Message

from src.agents.chat_parser import create_chat_parser_agent
from src.agents.skeleton import create_skeleton_agent
from src.agents.day_detail import create_day_detail_agent
from src.models.input import PlanningInput
from src.models.output import (
    ChangesSummary,
    PlanningOutput,
    SkeletonOutput,
    DayDetailOutput,
    merge_skeleton_and_days,
)
from src.similarity.layer_rules import (
    compute_achieved_similarity,
    compute_change_rules,
    compute_retain_ratio,
    extract_reference_data,
    format_rules_for_prompt,
    select_preserved,
)
from src.validator.itinerary_validator import validate_itinerary, validate_skeleton
from src.cache import get_cache
from src.mcp_connection import create_mcp_client, get_mcp_client, prefixed

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Context summarization helpers (token optimization)
# ---------------------------------------------------------------------------

def _parse_mcp_text(raw) -> dict | list | None:
    """Extract the inner JSON from an MCP ToolResult or raw string."""
    if raw is None:
        return None
    try:
        data = json.loads(str(raw)) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return None
    # Determine content blocks to unwrap (MCP ToolResult or cached content list)
    blocks = None
    if isinstance(data, dict) and "content" in data:
        blocks = data.get("content", [])
    elif isinstance(data, list):
        blocks = data

    if blocks:
        for block in blocks:
            if isinstance(block, dict) and "text" in block:
                try:
                    return json.loads(block["text"])
                except (json.JSONDecodeError, TypeError):
                    pass

    return data


def _summarize_bundle(bundle_raw) -> dict | None:
    """Compress plan_context_bundle for Skeleton prompt.

    Keeps reference summary, top-5 similar candidates, top-10 routes,
    top-5 popular hotels.
    """
    data = _parse_mcp_text(bundle_raw)
    if not isinstance(data, dict):
        return data
    out: dict = {}

    # Reference: summarize visit cities + scheduled attractions per day
    ref = data.get("reference") or {}
    if isinstance(ref, dict):
        sale = ref.get("saleProduct") or {}
        cities = []
        if ref.get("arrivalCity"):
            arr = ref["arrivalCity"]
            if isinstance(arr, dict) and arr.get("name"):
                cities.append(arr["name"])
        for c in ref.get("visitCities", []) or []:
            if isinstance(c, dict) and c.get("name") and c["name"] not in cities:
                cities.append(c["name"])
        # Scheduled attractions grouped by day
        sched = ref.get("scheduledAttractions") or []
        by_day: dict[int, list[str]] = {}
        for a in sched:
            if not isinstance(a, dict):
                continue
            day = a.get("schdDay")
            if day is None:
                continue
            by_day.setdefault(int(day), []).append(a.get("name", ""))
        # Hotels per day
        hotels = []
        for s in ref.get("hotelStays") or []:
            if not isinstance(s, dict):
                continue
            h = s.get("hotel") or {}
            name = h.get("name") if isinstance(h, dict) else None
            hotels.append({"day": s.get("schdDay"), "hotel": name or s.get("locaDesc")})
        out["reference"] = {
            "saleProdCd": sale.get("saleProdCd"),
            "name": sale.get("saleProdNm"),
            "brand": sale.get("brndNm"),
            "nights": sale.get("trvlNgtCnt"),
            "days": sale.get("trvlDayCnt"),
            "cities": cities,
            "attractions_by_day": by_day,
            "hotels": hotels,
        }

    # Similar candidates — top 5
    sim = data.get("similar") or {}
    if isinstance(sim, dict):
        cands = sim.get("candidates") or []
        out["similar"] = {
            "weights": sim.get("weights"),
            "candidates": [
                {
                    "saleProdCd": (c.get("saleProduct") or {}).get("saleProdCd"),
                    "name": (c.get("saleProduct") or {}).get("saleProdNm"),
                    "brand": (c.get("saleProduct") or {}).get("brndNm"),
                    "score": c.get("score"),
                    "breakdown": c.get("breakdown"),
                }
                for c in cands[:5]
                if isinstance(c, dict)
            ],
        }

    # Route — top 10 + top 5 hotels
    route = data.get("route") or {}
    if isinstance(route, dict):
        out["route"] = {
            "arrival_city": route.get("arrival_city"),
            "nights": route.get("nights"),
            "routes": (route.get("routes") or [])[:10],
            "popular_hotels": (route.get("popular_hotels") or [])[:5],
        }

    return out


def _summarize_recommended_attractions(raw) -> dict | None:
    """Compress recommended_attractions response for prompts (drop heavy fields)."""
    data = _parse_mcp_text(raw)
    if not isinstance(data, dict):
        return data
    items = []
    for a in data.get("attractions") or []:
        if not isinstance(a, dict):
            continue
        items.append(
            {
                "id": a.get("id"),
                "name": a.get("name"),
                "summary": a.get("summary"),
                "type": a.get("type"),
                "stay_minutes": a.get("stay_minutes"),
                "score": a.get("score"),
                "breakdown": a.get("breakdown"),
                "rationale": a.get("rationale"),
                "flags": a.get("flags"),
            }
        )
    return {
        "city": data.get("city"),
        "weights": data.get("weights"),
        "mood_keywords": data.get("mood_keywords"),
        "attractions": items,
        "count": len(items),
    }


def _build_skeleton_context(graph_context: dict) -> dict:
    """Build a reduced graph_context for Skeleton."""
    rec_attr = graph_context.get("recommended_attractions", {}) or {}
    rec_summary = {
        c: _summarize_recommended_attractions(v) for c, v in rec_attr.items()
    }
    return {
        "plan_context": _summarize_bundle(graph_context.get("plan_context")),
        "recommended_attractions": rec_summary,
    }


def _build_day_context(graph_context: dict, day_cities: list[str], day_num: int) -> dict:
    """Build a filtered graph_context for a specific Day Detail.

    Strict city scoping: only attractions whose IN_CITY matches one of
    day_cities are exposed. The set of allowed attraction names is also
    surfaced so the LLM can reject hallucinated names.
    """
    rec_attr = graph_context.get("recommended_attractions", {}) or {}
    bundle = _parse_mcp_text(graph_context.get("plan_context")) or {}
    ref = bundle.get("reference") if isinstance(bundle, dict) else None

    # Reference day attractions, scoped to day_cities only
    ref_day_attrs: list[dict] = []
    if isinstance(ref, dict):
        ref_cities_for_day = set(day_cities)
        for a in ref.get("scheduledAttractions") or []:
            if not isinstance(a, dict):
                continue
            if a.get("schdDay") != day_num:
                continue
            # If the reference attraction has cityName, enforce city match
            ac = a.get("cityName") or a.get("city")
            if ac and ac not in ref_cities_for_day:
                continue
            ref_day_attrs.append(
                {"id": a.get("id"), "name": a.get("name"), "type": a.get("type")}
            )

    # Filter recommended attractions to day_cities only
    day_rec = {
        c: _summarize_recommended_attractions(rec_attr[c])
        for c in day_cities
        if c in rec_attr
    }

    # Build explicit allow-list of attraction names so the LLM cannot pick
    # anything outside the day cities' graph candidates.
    allowed_names: set[str] = set()
    for v in day_rec.values():
        if isinstance(v, dict):
            for a in v.get("attractions") or []:
                if isinstance(a, dict) and a.get("name"):
                    allowed_names.add(a["name"])
    for a in ref_day_attrs:
        if a.get("name"):
            allowed_names.add(a["name"])

    return {
        "day_cities": day_cities,
        "recommended_attractions": day_rec,
        "reference_day_attractions": ref_day_attrs,
        "allowed_attraction_names": sorted(allowed_names),
        "_strict_rule": (
            "이 day 의 cities 가 아닌 도시의 명소를 절대 사용하지 마세요. "
            "allowed_attraction_names 에 없는 이름을 만들어내면 검증에서 차단됩니다."
        ),
    }


def _make_agent_result(text: str) -> AgentResult:
    """Helper to wrap plain text into an AgentResult."""
    return AgentResult(
        stop_reason="end_turn",
        message=Message(role="assistant", content=[ContentBlock(text=text)]),
        metrics={},
        state={},
    )


# ---------------------------------------------------------------------------
# Node 1: Parse Input
# ---------------------------------------------------------------------------
class ParseInputNode(MultiAgentBase):
    """Parse raw input into PlanningInput and compute similarity rules.

    - Mode A (chat): invokes the chat_parser_agent (Sonnet) to parse
      natural language into PlanningInput.
    - Mode B (form): PlanningInput is already structured; pass through.

    Appends the 5-Layer similarity rules to the state for downstream nodes.
    """

    def __init__(self) -> None:
        super().__init__()
        self._chat_parser = None  # lazy init

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        start = time.time()
        invocation_state = invocation_state or {}

        # Extract the PlanningInput from invocation_state
        raw_input = invocation_state.get("planning_input")
        if raw_input is None:
            # Try to parse from the task string (fallback)
            try:
                raw_input = json.loads(str(task))
            except (json.JSONDecodeError, TypeError):
                raw_input = {"destination": str(task), "duration": {"nights": 3, "days": 4}, "departure_season": "봄"}

        # Determine mode
        input_mode = raw_input.get("input_mode", "form") if isinstance(raw_input, dict) else "form"

        if input_mode == "chat":
            # Mode A: use chat parser agent
            if self._chat_parser is None:
                self._chat_parser = create_chat_parser_agent()
            nl_text = raw_input.get("natural_language_request", str(task))
            result = self._chat_parser(nl_text)
            planning_input = result.structured_output
        else:
            # Mode B: direct construction
            if isinstance(raw_input, dict):
                planning_input = PlanningInput(**raw_input)
            elif isinstance(raw_input, PlanningInput):
                planning_input = raw_input
            else:
                planning_input = PlanningInput(**json.loads(str(raw_input)))

        # Compute similarity rules
        similarity = planning_input.similarity_level
        rules = compute_change_rules(similarity)
        rules_prompt = format_rules_for_prompt(similarity)

        # Store in invocation_state for downstream
        invocation_state["planning_input_parsed"] = planning_input.model_dump()
        invocation_state["similarity_rules"] = rules
        invocation_state["similarity_rules_prompt"] = rules_prompt

        output_text = json.dumps({
            "planning_input": planning_input.model_dump(),
            "similarity_rules": rules,
            "rules_prompt": rules_prompt,
        }, ensure_ascii=False, default=str)

        elapsed = time.time() - start
        logger.info("ParseInputNode completed in %.2fs", elapsed)

        agent_result = _make_agent_result(output_text)
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={"parse_input": NodeResult(result=agent_result, status=Status.COMPLETED, execution_time=int(elapsed * 1000))},
        )


# ---------------------------------------------------------------------------
# Node 2: Collect Context
# ---------------------------------------------------------------------------
class CollectContextNode(MultiAgentBase):
    """Call multiple Graph RAG tools via MCP Gateway to gather context.

    Collects: reference package, similar packages, routes, attractions,
    hotels. All calls go through AgentCore Gateway MCP. Trend tools are
    intentionally not invoked in the v3 phase.
    """

    def __init__(self) -> None:
        super().__init__()

    @staticmethod
    def _collect_context_via_mcp(planning_input: dict) -> dict:
        """Call graph tools via MCP Gateway synchronously.

        Score-first redesign:
        - 1 call to plan_context_bundle (reference + similar + route)
        - 1 call to recommend_attractions per relevant city (theme/season aware)
        """
        mcp = get_mcp_client()

        destination = planning_input.get("destination", "")
        season = planning_input.get("departure_season", "")
        nights = planning_input.get("duration", {}).get("nights", 0)
        themes = planning_input.get("themes", []) or []
        brand = planning_input.get("brand", "") or ""
        reference_id = planning_input.get("reference_product_id") or ""
        free_text = planning_input.get("natural_language_request", "") or ""

        # destination 은 폼에서 단일 도시 (간사이 4도시 중 하나)로 들어옴
        arrival_city = destination.split()[-1] if destination else destination

        # 시즌 매핑 (한국어 → 분기)
        season_q_map = {"봄": 2, "여름": 3, "가을": 4, "겨울": 1}
        season_quarter = season_q_map.get(season, 0)

        # themes 에서 첫 companion / interest 키 추출 (영문 키만 받는다)
        primary_theme_key = ""
        for t in themes:
            if isinstance(t, str) and t.isupper():
                primary_theme_key = t
                break

        context_parts: dict = {}
        graph_trace: list[dict] = []
        _call_id = 0
        cache = get_cache()

        def _extract_inner_payload(result: object) -> object:
            try:
                if isinstance(result, dict) and "content" in result:
                    inner = result["content"][0].get("text")
                    if isinstance(inner, str):
                        return json.loads(inner)
                    return inner
            except (KeyError, IndexError, TypeError, ValueError):
                pass
            return result

        def _safe_call(key: str, tool_name: str, arguments: dict):
            nonlocal _call_id
            _call_id += 1
            started = time.time()

            cached = cache.get(tool_name, arguments)
            if cached is not None:
                context_parts[key] = cached
                inner = _extract_inner_payload(cached)
                trace_meta = (
                    inner.get("_trace") if isinstance(inner, dict) else None
                ) or {}
                graph_trace.append(
                    {
                        "tool": tool_name,
                        "arguments": arguments,
                        "source": "agent_cache",
                        "latency_ms": round((time.time() - started) * 1000, 1),
                        "queries": trace_meta.get("queries", []),
                    }
                )
                return

            try:
                result = mcp.call_tool_sync(
                    tool_use_id=f"ctx-{_call_id}",
                    name=prefixed(tool_name),
                    arguments=arguments,
                )
                context_parts[key] = result
                cache.set(tool_name, arguments, result)
                inner = _extract_inner_payload(result)
                trace_meta = (
                    inner.get("_trace") if isinstance(inner, dict) else None
                ) or {}
                graph_trace.append(
                    {
                        "tool": tool_name,
                        "arguments": arguments,
                        "source": trace_meta.get("source", "live"),
                        "latency_ms": round((time.time() - started) * 1000, 1),
                        "queries": trace_meta.get("queries", []),
                    }
                )
            except Exception as e:
                logger.warning("MCP call failed %s/%s: %s", key, tool_name, e)
                graph_trace.append(
                    {
                        "tool": tool_name,
                        "arguments": arguments,
                        "source": "error",
                        "latency_ms": round((time.time() - started) * 1000, 1),
                        "queries": [],
                        "error": str(e),
                    }
                )

        # 1. Skeleton 컨텍스트 — 1회 호출로 reference + similar + route 일괄
        bundle_args: dict = {"arrival_city": arrival_city}
        if nights:
            bundle_args["nights"] = nights
        if reference_id:
            bundle_args["saleProdCd"] = reference_id
        if primary_theme_key:
            bundle_args["theme_key"] = primary_theme_key
        if season_quarter:
            bundle_args["season_quarter"] = season_quarter
        if brand:
            bundle_args["brand"] = brand
        _safe_call("plan_context", "plan_context_bundle", bundle_args)

        # 2. 어떤 도시들을 day detail 단계에서 다룰지 결정
        #    (1) 사용자 destination
        #    (2) reference 의 visit cities (있으면)
        cities_to_query: list[str] = []
        if arrival_city:
            cities_to_query.append(arrival_city)

        plan_inner = _extract_inner_payload(context_parts.get("plan_context"))
        if isinstance(plan_inner, dict):
            ref = plan_inner.get("reference") or {}
            if isinstance(ref, dict):
                for c in ref.get("visitCities", []) or []:
                    if isinstance(c, dict) and c.get("name"):
                        nm = c["name"]
                        if nm and nm not in cities_to_query:
                            cities_to_query.append(nm)
                arr = ref.get("arrivalCity") or {}
                if (
                    isinstance(arr, dict)
                    and arr.get("name")
                    and arr["name"] not in cities_to_query
                ):
                    cities_to_query.append(arr["name"])

        # 출발 도시는 제외
        DEPARTURE = {"인천", "김포", "부산", "대구", "제주", "청주", "무안", "양양"}
        cities_to_query = [c for c in cities_to_query if c not in DEPARTURE]
        cities_to_query = cities_to_query[:5]

        # 3. 도시별 점수 기반 명소 ranked top-15 prefetch
        #    LLM 이 자유 텍스트 보고 가중치/mood_keywords 를 직접 결정하도록
        #    Day Detail Agent 가 호출할 수도 있지만, prefetch 해두면 cache hit
        attractions_by_city: dict = {}
        for cname in cities_to_query:
            args: dict = {"city": cname, "limit": 15}
            if primary_theme_key:
                args["theme_key"] = primary_theme_key
            if season_quarter:
                args["season_quarter"] = season_quarter
            key = f"_attr_{cname}"
            _safe_call(key, "recommend_attractions", args)
            res = context_parts.pop(key, None)
            if res:
                attractions_by_city[cname] = res

        if attractions_by_city:
            context_parts["recommended_attractions"] = attractions_by_city

        # 4. 사용자 자유 텍스트 → mood keywords / weights 힌트
        context_parts["__free_text__"] = free_text
        context_parts["__primary_theme_key__"] = primary_theme_key
        context_parts["__season_quarter__"] = season_quarter
        context_parts["__cities_to_query__"] = cities_to_query
        context_parts["__graph_trace__"] = graph_trace

        return context_parts

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        start = time.time()
        invocation_state = invocation_state or {}

        planning_input = invocation_state.get("planning_input_parsed", {})

        # MCP calls are synchronous HTTP -- run in a thread to avoid
        # blocking the async event loop.
        context_parts = await asyncio.to_thread(
            self._collect_context_via_mcp, planning_input
        )

        # 메타 키 분리 (graph_context 에 포함시키면 LLM 프롬프트가 비대해짐)
        graph_trace = context_parts.pop("__graph_trace__", [])
        free_text = context_parts.pop("__free_text__", "")
        primary_theme_key = context_parts.pop("__primary_theme_key__", "")
        season_quarter = context_parts.pop("__season_quarter__", 0)
        cities_to_query = context_parts.pop("__cities_to_query__", [])

        invocation_state["graph_trace"] = graph_trace
        invocation_state["natural_language_request"] = free_text
        invocation_state["primary_theme_key"] = primary_theme_key
        invocation_state["season_quarter"] = season_quarter
        invocation_state["cities_in_scope"] = cities_to_query

        # Store context for downstream
        invocation_state["graph_context"] = context_parts

        output_text = json.dumps(context_parts, ensure_ascii=False, default=str)

        elapsed = time.time() - start
        logger.info("CollectContextNode completed in %.2fs", elapsed)

        agent_result = _make_agent_result(output_text)
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={"collect_context": NodeResult(result=agent_result, status=Status.COMPLETED, execution_time=int(elapsed * 1000))},
        )


# ---------------------------------------------------------------------------
# Node 3: Generate Skeleton (Phase 1 — Sonnet, fast)
# ---------------------------------------------------------------------------
class GenerateSkeletonNode(MultiAgentBase):
    """Phase 1: Generate travel structure (cities, flights, hotels, pricing)."""

    def __init__(self) -> None:
        super().__init__()
        self._agent = None

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        start = time.time()
        invocation_state = invocation_state or {}

        if self._agent is None:
            self._agent = create_skeleton_agent()

        planning_input = invocation_state.get("planning_input_parsed", {})
        graph_context = invocation_state.get("graph_context", {})
        correction_guide = invocation_state.get("skeleton_correction_guide", "")
        retry_count = invocation_state.get("skeleton_retry_count", 0)

        # 유사도 규칙을 reference 의 실제 값과 함께 프롬프트로 재생성.
        # plan_context_bundle 응답 안의 'reference' 가 v3 reference 모양.
        similarity = int(planning_input.get("similarity_level", 50))
        bundle_inner = _parse_mcp_text(graph_context.get("plan_context")) or {}
        ref_raw = bundle_inner.get("reference") if isinstance(bundle_inner, dict) else None
        ref_data = extract_reference_data(ref_raw) if ref_raw else {}
        rules_prompt = format_rules_for_prompt(similarity, reference_data=ref_data)

        parts = [
            "## 기획 요청",
            json.dumps(planning_input, ensure_ascii=False, default=str),
            "",
            rules_prompt,
            "",
            "## Graph 컨텍스트 (Skeleton용 축약)",
            json.dumps(_build_skeleton_context(graph_context), ensure_ascii=False, default=str),
        ]

        if correction_guide:
            parts.extend([
                "",
                f"## 이전 골격 검증 실패 (재시도 {retry_count}/3)",
                correction_guide,
                "",
                "위 문제를 수정하여 다시 골격을 생성하세요.",
            ])

        result = self._agent("\n".join(parts))
        skeleton: SkeletonOutput = result.structured_output

        # ── 유사도 강제 후처리 (gradient) ───────────────────────────────────
        # 각 layer 의 retain ratio 만큼 reference 항목을 보존하고, 나머지는
        # LLM 출력의 신규 항목으로 채운다. 보존 슬롯은 코드 레벨에서 강제
        # 삽입하여 사용자 입력 의도를 보장.
        ratios = compute_retain_ratio(similarity)
        rules = compute_change_rules(similarity)  # legacy 호환용 표시값

        if ref_data:
            ref_cities = list(ref_data.get("cities") or [])
            if ref_cities:
                kept_cities = select_preserved(ref_cities, ratios["route"])
                merged_cities: list[str] = list(kept_cities)
                for c in skeleton.city_list or []:
                    if c and c not in merged_cities:
                        merged_cities.append(c)
                # 도시 수는 reference 와 동일하게 유지(여행 일수 매칭)
                target_n = len(ref_cities)
                skeleton.city_list = merged_cities[:target_n]
                if skeleton.city_list:
                    skeleton.travel_cities = "-".join(skeleton.city_list)

            ref_hotels = list(ref_data.get("hotels") or [])
            if ref_hotels:
                kept_hotels = select_preserved(ref_hotels, ratios["hotel"])
                merged_hotels: list[str] = list(kept_hotels)
                for h in skeleton.hotels or []:
                    if h and h not in merged_hotels:
                        merged_hotels.append(h)
                target_n_h = len(ref_hotels)
                skeleton.hotels = merged_hotels[:target_n_h]
            # attractions 는 day_detail 단계에서 ratio 기반으로 보존 강제

        invocation_state["skeleton_output"] = skeleton.model_dump()
        invocation_state["skeleton_output_obj"] = skeleton
        invocation_state["similarity_rules"] = rules
        invocation_state["similarity_ratios"] = ratios
        invocation_state["reference_retain_data"] = ref_data

        output_text = json.dumps(skeleton.model_dump(), ensure_ascii=False, default=str)
        elapsed = time.time() - start
        logger.info("GenerateSkeletonNode completed in %.2fs", elapsed)

        agent_result = _make_agent_result(output_text)
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={"generate_skeleton": NodeResult(result=agent_result, status=Status.COMPLETED, execution_time=int(elapsed * 1000))},
        )


# ---------------------------------------------------------------------------
# Node 4: Validate Skeleton
# ---------------------------------------------------------------------------
class ValidateSkeletonNode(MultiAgentBase):
    """Validate skeleton structure: day count, route logic, flight buffer."""

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        start = time.time()
        invocation_state = invocation_state or {}

        skeleton_data = invocation_state.get("skeleton_output")
        if skeleton_data and isinstance(skeleton_data, dict):
            skeleton = SkeletonOutput(**skeleton_data)
        else:
            skeleton = invocation_state.get("skeleton_output_obj")
        if skeleton is None:
            raise RuntimeError("ValidateSkeletonNode: no skeleton found")

        validation = validate_skeleton(skeleton)
        retry_count = invocation_state.get("skeleton_retry_count", 0)

        if validation.passed:
            invocation_state["skeleton_validation_passed"] = True
            invocation_state["skeleton_needs_retry"] = False
            status_msg = f"SKELETON_PASS (score={validation.score})"
        elif retry_count < 3:
            invocation_state["skeleton_validation_passed"] = False
            invocation_state["skeleton_needs_retry"] = True
            invocation_state["skeleton_retry_count"] = retry_count + 1
            invocation_state["skeleton_correction_guide"] = validation.correction_guide
            status_msg = f"SKELETON_FAIL (score={validation.score}, retry {retry_count + 1}/3)"
        else:
            invocation_state["skeleton_validation_passed"] = True
            invocation_state["skeleton_needs_retry"] = False
            status_msg = f"SKELETON_PASS_WITH_WARNINGS (score={validation.score})"

        elapsed = time.time() - start
        logger.info("ValidateSkeletonNode completed in %.2fs -- %s", elapsed, status_msg)

        output_text = json.dumps({"status": status_msg}, ensure_ascii=False)
        agent_result = _make_agent_result(output_text)
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={"validate_skeleton": NodeResult(result=agent_result, status=Status.COMPLETED, execution_time=int(elapsed * 1000))},
        )


# ---------------------------------------------------------------------------
# Day Details helpers (shared by Prepare / SingleDay / Aggregate nodes)
# ---------------------------------------------------------------------------
class _DayBudget:
    """Encapsulates time-budget + attraction-partition logic for day workers."""

    @staticmethod
    def compute(
        day_num: int, total_days: int, skeleton, num_cities: int = 1
    ) -> dict:
        """Compute time budget for a day.

        Returns dict with:
          available_hours: 가용 시간 (식사 1.5h 미포함, 도시간 이동 미포함)
          max_attractions: 관광지 수 상한
          rationale: 계산 근거 텍스트
        """
        # 도시간 이동 페널티: 도시 N 개면 (N-1) * 1h 차감
        intercity_travel_h = max(0, (num_cities - 1)) * 1.0

        if day_num == 1:
            # 도착 후 입국 3h 버퍼
            try:
                arr_h, _ = map(int, skeleton.departure_flight.arrival_time.split(":"))
                end_h = 21  # 식사·휴식 고려해 21시 종료
                start_h = arr_h + 3
                available = max(0.0, end_h - start_h - intercity_travel_h)
            except (ValueError, AttributeError):
                available = 4.0
            rationale = "도착 후 3h 버퍼 + 21시 종료 기준"
        elif day_num == total_days:
            # 출국 3h 전 종료
            try:
                dep_h, _ = map(int, skeleton.return_flight.departure_time.split(":"))
                start_h = 9
                end_h = dep_h - 3
                available = max(0.0, end_h - start_h - intercity_travel_h)
            except (ValueError, AttributeError):
                available = 3.0
            rationale = "오전 9시 시작 + 출발 3h 전 종료 기준"
        else:
            # 09~21 = 12h, 식사 휴식 1.5h, 도시간 이동 차감
            available = max(0.0, 12.0 - 1.5 - intercity_travel_h)
            rationale = "09:00~21:00 (식사 1.5h, 도시간 이동 제외)"

        # 명소당 1.5h 관광 + 0.5h 명소간 이동 = 2h
        max_attr = max(1, int(available / 2.0))
        return {
            "available_hours": round(available, 1),
            "max_attractions": max_attr,
            "rationale": rationale,
            "num_cities": num_cities,
            "intercity_travel_h": round(intercity_travel_h, 1),
        }

    @staticmethod
    def partition_attractions(sorted_allocs, graph_context: dict) -> dict[int, list[str]]:
        """Pre-assign attractions to each day to prevent cross-day duplicates.

        For days sharing the same city, attractions are round-robin split so
        each day gets a disjoint subset.  Returns {day_num: [attraction_names]}.
        """
        city_attractions: dict = graph_context.get("city_attractions", {})
        # Group days by city
        city_days: dict[str, list] = {}
        for alloc in sorted_allocs:
            for city in [c.strip() for c in alloc.cities.split(",") if c.strip()]:
                city_days.setdefault(city, []).append(alloc.day)

        day_assigned: dict[int, list[str]] = {alloc.day: [] for alloc in sorted_allocs}

        for city, days in city_days.items():
            raw = city_attractions.get(city)
            if not raw:
                continue
            # Extract attraction names from the graph context data
            names: list[str] = []
            if isinstance(raw, str):
                for m in re.finditer(r'"name":\s*"([^"]+)"', raw):
                    names.append(m.group(1))
            elif isinstance(raw, dict):
                for item in raw.get("attractions", raw.get("data", [])):
                    if isinstance(item, dict) and "name" in item:
                        names.append(item["name"])
            elif isinstance(raw, list):
                for item in raw:
                    if isinstance(item, dict) and "name" in item:
                        names.append(item["name"])

            # Round-robin distribute attractions across days sharing this city
            for i, name in enumerate(names):
                target_day = days[i % len(days)]
                day_assigned[target_day].append(name)

        return day_assigned


def _build_day_prompt(
    *,
    day_alloc,
    sorted_allocs,
    skeleton: SkeletonOutput,
    graph_context: dict,
    rules_prompt: str,
    day_attractions: dict[int, list[str]],
    other_days_attractions: list[str],
    must_include: list[str] | None = None,
    correction: str = "",
) -> str:
    """Render the user prompt for a single day's detail agent.

    ``must_include`` is the slice of reference attractions assigned to this
    day under the gradient retain ratio; the agent is required to include
    these names verbatim. Aggregate-time enforcement re-injects any that the
    LLM dropped.
    """
    idx = next(i for i, a in enumerate(sorted_allocs) if a.day == day_alloc.day)

    prev_last_city = ""
    if idx > 0:
        prev_cities = sorted_allocs[idx - 1].cities
        prev_last_city = (
            [c.strip() for c in prev_cities.split(",") if c.strip()][-1]
            if prev_cities
            else ""
        )

    next_first_city = ""
    if idx < len(sorted_allocs) - 1:
        next_cities = sorted_allocs[idx + 1].cities
        next_first_city = (
            [c.strip() for c in next_cities.split(",") if c.strip()][0]
            if next_cities
            else ""
        )

    day_city_list = [c.strip() for c in day_alloc.cities.split(",") if c.strip()]
    budget = _DayBudget.compute(
        day_alloc.day, skeleton.days, skeleton, num_cities=len(day_city_list)
    )
    max_attr = budget["max_attractions"]

    parts = [
        f"## {day_alloc.day}일차 상세 기획",
        f"- 날짜: {day_alloc.date} ({day_alloc.day_of_week})",
        f"- 도시: {day_alloc.cities}",
        f"- 숙소: {skeleton.hotels[day_alloc.day - 1] if day_alloc.day <= len(skeleton.hotels) else '(귀국일)'}",
        f"- 항공편: 출발편 도착 {skeleton.departure_flight.arrival_time} / 귀국편 출발 {skeleton.return_flight.departure_time}",
        f"- 전체 일정: {skeleton.days}일 중 {day_alloc.day}일차",
        f"- **시간 예산**: 가용 {budget['available_hours']}h "
        f"(도시 {budget['num_cities']}개, 도시간 이동 -{budget['intercity_travel_h']}h, {budget['rationale']})",
        f"- **관광지 상한: {max_attr}개** (절대 초과 금지)",
        f"- 명소당 평균: 관광 1.5h + 이동 0.5h = 2h. stay_minutes 가 있으면 그 값을 사용.",
    ]
    if prev_last_city:
        parts.append(f"- 전날 마지막 도시: {prev_last_city} → 오늘 첫 도시와 동일해야 함")
    if next_first_city:
        parts.append(f"- 다음날 첫 도시: {next_first_city} → 오늘 마지막 도시와 동일해야 함")

    assigned = day_attractions.get(day_alloc.day, [])
    parts.extend(
        [
            "",
            rules_prompt,
            "",
            "## 이 일차에 배정된 추천 관광지",
            ", ".join(assigned) if assigned else "(자유 선택)",
            "",
            "## 다른 일차 관광지 (중복 금지)",
            ", ".join(set(other_days_attractions)) if other_days_attractions else "(없음)",
        ]
    )

    if must_include:
        parts.extend(
            [
                "",
                "## 반드시 포함해야 할 reference 명소 (similarity 보존)",
                ", ".join(must_include),
                "위 명소는 이름까지 정확히 그대로 attractions 에 넣어주세요. 누락 시 검증 실패.",
            ]
        )

    parts.extend(
        [
            "",
            "## Graph 컨텍스트 (이 일차 도시 관련만)",
            json.dumps(
                _build_day_context(graph_context, day_city_list, day_alloc.day),
                ensure_ascii=False,
                default=str,
            ),
        ]
    )
    if correction:
        parts.extend(["", "## 이전 검증 실패", correction, "위 문제를 수정하세요."])
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Node 5a: Prepare Day Prompts (coordinator before fan-out)
# ---------------------------------------------------------------------------
class PrepareDayPromptsNode(MultiAgentBase):
    """Build per-day prompts and persist them in invocation_state.

    Splitting prompt construction off from generation lets each day worker
    be a pure leaf in the graph (one agent call → one structured output).
    Prompts for already-passed days are skipped on retry.
    """

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        start = time.time()
        invocation_state = invocation_state or {}

        skeleton_data = invocation_state.get("skeleton_output")
        if skeleton_data:
            skeleton = SkeletonOutput(**skeleton_data)
        else:
            skeleton = invocation_state.get("skeleton_output_obj")
        if skeleton is None:
            raise RuntimeError("PrepareDayPromptsNode: no skeleton in invocation_state")

        graph_context = invocation_state.get("graph_context", {})
        failed_days = invocation_state.get("failed_days", [])

        # Rebuild rules_prompt with concrete reference values so the gradient
        # ratio + preserved item lists are visible to each day worker.
        planning_input_dict = invocation_state.get("planning_input_parsed", {})
        similarity_level = int(planning_input_dict.get("similarity_level", 50))
        ref_data_for_prompt = invocation_state.get("reference_retain_data") or {}
        rules_prompt = format_rules_for_prompt(
            similarity_level, reference_data=ref_data_for_prompt
        )
        invocation_state["similarity_rules_prompt"] = rules_prompt

        existing_details = invocation_state.get("day_details_list", [])
        existing_by_day = {d["day"]: d for d in existing_details}

        sorted_allocs = sorted(skeleton.day_allocations, key=lambda d: d.day)
        day_attractions = _DayBudget.partition_attractions(sorted_allocs, graph_context)

        existing_attractions: list[str] = []
        for alloc in sorted_allocs:
            if (
                failed_days
                and alloc.day not in failed_days
                and alloc.day in existing_by_day
            ):
                existing_attractions.extend(
                    DayDetailOutput(**existing_by_day[alloc.day]).attractions
                )

        # Gradient retain: pick the first round(N×ratio) reference attractions
        # and assign each to a day whose cities actually contain it. Without
        # this guard, must-include names get round-robin'd onto days that
        # can't host them, which makes the city-scope validator fail every
        # retry. Names with no resolvable city or no matching day fall back
        # to plain round-robin so they're still surfaced somewhere.
        ratios = invocation_state.get("similarity_ratios") or {}
        ref_data = invocation_state.get("reference_retain_data") or {}
        ref_attrs = list(ref_data.get("attractions") or [])
        attr_city_map: dict[str, str] = dict(
            ref_data.get("attraction_cities") or {}
        )
        attraction_ratio = float(ratios.get("attraction", 0.0)) if ratios else 0.0
        preserved_attrs = select_preserved(ref_attrs, attraction_ratio)

        # day → set of cities that day visits (used to gate placement)
        day_to_cities: dict[int, set[str]] = {}
        for alloc in sorted_allocs:
            day_to_cities[alloc.day] = {
                c.strip() for c in (alloc.cities or "").split(",") if c.strip()
            }

        must_include_by_day: dict[int, list[str]] = {a.day: [] for a in sorted_allocs}
        unplaced: list[str] = []
        for name in preserved_attrs:
            city = attr_city_map.get(name, "")
            placed = False
            if city:
                # Days whose cities contain this attraction's city, ordered
                # by current load so we balance across them.
                candidates = [
                    d for d, cs in day_to_cities.items() if city in cs
                ]
                if candidates:
                    candidates.sort(key=lambda d: len(must_include_by_day[d]))
                    must_include_by_day[candidates[0]].append(name)
                    placed = True
            if not placed:
                unplaced.append(name)

        # Fallback for attractions we couldn't city-match: round-robin
        # across the lightest-loaded days so they still appear somewhere.
        if unplaced:
            day_order = [a.day for a in sorted_allocs]
            for name in unplaced:
                day_order.sort(key=lambda d: len(must_include_by_day[d]))
                must_include_by_day[day_order[0]].append(name)

        invocation_state["must_include_attractions"] = list(preserved_attrs)
        invocation_state["must_include_by_day"] = {
            str(k): v for k, v in must_include_by_day.items()
        }

        prompts: dict[int, str] = {}
        days_to_generate: list[int] = []
        for day_alloc in sorted_allocs:
            if (
                failed_days
                and day_alloc.day not in failed_days
                and day_alloc.day in existing_by_day
            ):
                continue
            other_attrs = existing_attractions.copy()
            for other_day, other_list in day_attractions.items():
                if other_day != day_alloc.day:
                    other_attrs.extend(other_list)
            prompts[day_alloc.day] = _build_day_prompt(
                day_alloc=day_alloc,
                sorted_allocs=sorted_allocs,
                skeleton=skeleton,
                graph_context=graph_context,
                rules_prompt=rules_prompt,
                day_attractions=day_attractions,
                other_days_attractions=other_attrs,
                must_include=must_include_by_day.get(day_alloc.day, []),
                correction=invocation_state.get(f"day_{day_alloc.day}_correction", ""),
            )
            days_to_generate.append(day_alloc.day)

        invocation_state["day_prompts"] = prompts
        invocation_state["day_allocs_serialized"] = [a.model_dump() for a in sorted_allocs]
        invocation_state["days_to_generate"] = days_to_generate

        output_text = json.dumps(
            {"days_to_generate": days_to_generate}, ensure_ascii=False
        )
        elapsed = time.time() - start
        logger.info(
            "PrepareDayPromptsNode completed in %.2fs (days=%s)",
            elapsed,
            days_to_generate,
        )
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={
                "prepare_day_prompts": NodeResult(
                    result=_make_agent_result(output_text),
                    status=Status.COMPLETED,
                    execution_time=int(elapsed * 1000),
                )
            },
        )


# ---------------------------------------------------------------------------
# Node 5b: Generate Single Day (one parallel worker per day)
# ---------------------------------------------------------------------------
class GenerateSingleDayNode(MultiAgentBase):
    """One parallel branch in the graph — generates a single day's detail.

    Each instance owns its own ``MCPClient`` for the duration of the call so
    that workers don't serialize on the shared client's single background
    event loop.  No-ops if ``failed_days`` is set and this day isn't in it
    (so the same fan-out topology can be reused for retry).
    """

    def __init__(self, day_num: int) -> None:
        super().__init__()
        self.day_num = day_num

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        start = time.time()
        invocation_state = invocation_state or {}
        node_key = f"generate_day_{self.day_num}"

        prompts: dict[int, str] = invocation_state.get("day_prompts", {})
        prompt = prompts.get(self.day_num)

        # No work needed: this day already passed validation on a prior loop.
        if prompt is None:
            elapsed = time.time() - start
            logger.info(
                "GenerateSingleDayNode[day=%d]: skipped (no prompt)", self.day_num
            )
            return MultiAgentResult(
                status=Status.COMPLETED,
                results={
                    node_key: NodeResult(
                        result=_make_agent_result(json.dumps({"skipped": True})),
                        status=Status.COMPLETED,
                        execution_time=int(elapsed * 1000),
                    )
                },
            )

        # Lookup matching day allocation for post-fill
        allocs_raw = invocation_state.get("day_allocs_serialized", [])
        from src.models.output import SkeletonDayAllocation
        sorted_allocs = [SkeletonDayAllocation(**a) for a in allocs_raw]

        # Each worker holds its own MCP client (own bg thread + asyncio loop
        # + streamable HTTP session) so that Gateway calls run concurrently.
        mcp = await asyncio.to_thread(create_mcp_client)
        try:
            agent = await asyncio.to_thread(create_day_detail_agent, mcp)
            result = await asyncio.to_thread(agent, prompt)
        finally:
            try:
                await asyncio.to_thread(mcp.stop, None, None, None)
            except Exception as stop_err:
                logger.warning(
                    "MCPClient stop failed for day=%d: %s", self.day_num, stop_err
                )

        detail: DayDetailOutput = result.structured_output
        for alloc in sorted_allocs:
            if alloc.day == self.day_num:
                detail.day = alloc.day
                detail.date = alloc.date
                detail.day_of_week = alloc.day_of_week
                detail.cities = alloc.cities
                break

        # Stash into invocation_state under a per-day key so the aggregator
        # can pick it up regardless of execution ordering or retry batches.
        day_results = invocation_state.setdefault("day_results", {})
        day_results[self.day_num] = detail.model_dump()

        elapsed = time.time() - start
        logger.info(
            "GenerateSingleDayNode[day=%d] completed in %.2fs",
            self.day_num,
            elapsed,
        )
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={
                node_key: NodeResult(
                    result=_make_agent_result(
                        json.dumps({"day": self.day_num}, ensure_ascii=False)
                    ),
                    status=Status.COMPLETED,
                    execution_time=int(elapsed * 1000),
                )
            },
        )


# ---------------------------------------------------------------------------
# Node 5c: Aggregate Days (fan-in)
# ---------------------------------------------------------------------------
class AggregateDaysNode(MultiAgentBase):
    """Merge per-day outputs into final PlanningOutput + similarity post-processing."""

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        start = time.time()
        invocation_state = invocation_state or {}

        skeleton_data = invocation_state.get("skeleton_output")
        if skeleton_data:
            skeleton = SkeletonOutput(**skeleton_data)
        else:
            skeleton = invocation_state.get("skeleton_output_obj")
        if skeleton is None:
            raise RuntimeError("AggregateDaysNode: no skeleton in invocation_state")

        sorted_allocs = sorted(skeleton.day_allocations, key=lambda d: d.day)

        # day_results is the live store updated by parallel workers; for
        # days that already passed earlier, fall back to day_details_list.
        live_by_day: dict = invocation_state.get("day_results", {})
        existing_by_day = {
            d["day"]: d for d in invocation_state.get("day_details_list", [])
        }

        day_details: list[DayDetailOutput] = []
        for alloc in sorted_allocs:
            if alloc.day in live_by_day:
                day_details.append(DayDetailOutput(**live_by_day[alloc.day]))
            elif alloc.day in existing_by_day:
                day_details.append(DayDetailOutput(**existing_by_day[alloc.day]))

        # ── Similarity gradient enforcement (L3 attraction)
        # Re-insert any preserved reference attractions that the LLM dropped.
        # The day_to_must mapping was decided at PrepareDayPromptsNode based
        # on the gradient retain ratio, so we put each missing name back on
        # the day it was originally assigned to (falls back to last day).
        ref_data = invocation_state.get("reference_retain_data") or {}
        must_by_day_raw = invocation_state.get("must_include_by_day") or {}
        must_by_day: dict[int, list[str]] = {}
        for k, v in must_by_day_raw.items():
            try:
                must_by_day[int(k)] = list(v) if isinstance(v, list) else []
            except (TypeError, ValueError):
                continue

        if must_by_day and day_details:
            day_index = {d.day: d for d in day_details}
            attr_city_map = dict((ref_data.get("attraction_cities") or {}))
            inserted = 0
            for day_num, names in must_by_day.items():
                target = day_index.get(day_num) or day_details[-1]
                target_cities = {
                    c.strip()
                    for c in (target.cities or "").split(",")
                    if c.strip()
                }
                existing_names = set(target.attractions)
                for name in names:
                    if not name or name in existing_names:
                        continue
                    # Only append if the attraction's city actually matches
                    # this day. Otherwise dropping it is preferable to
                    # injecting a city-scope violation that retries can't
                    # resolve. The achieved_similarity calc later still
                    # reflects the real outcome.
                    city = attr_city_map.get(name, "")
                    if city and target_cities and city not in target_cities:
                        continue
                    target.attractions.append(name)
                    existing_names.add(name)
                    inserted += 1
            if inserted:
                logger.info(
                    "Similarity gradient: appended %d missing preserved attractions",
                    inserted,
                )

        planning_input_dict = invocation_state.get("planning_input_parsed", {})
        final_output = merge_skeleton_and_days(
            skeleton, day_details, planning_input=planning_input_dict
        )

        # similarity_score: force-sync to user-requested value
        target_similarity = int(planning_input_dict.get("similarity_level", 50))
        final_output.similarity_score = target_similarity

        # ── A3: actual achieved similarity (Jaccard vs reference)
        try:
            achieved = compute_achieved_similarity(final_output, ref_data)
            final_output.achieved_similarity = achieved["achieved"]
            final_output.similarity_breakdown = achieved["breakdown"]
        except Exception as e:  # noqa: BLE001
            logger.warning("achieved similarity calc failed: %s", e)
        if final_output.changes_summary is not None:
            final_output.changes_summary.similarity_applied = target_similarity
            rules_legacy = invocation_state.get("similarity_rules") or {}
            modified_layers = [
                layer for layer, decision in rules_legacy.items() if decision == "modify"
            ]
            if modified_layers:
                final_output.changes_summary.layers_modified = modified_layers

        graph_trace = invocation_state.get("graph_trace") or []
        if graph_trace:
            final_output.graph_trace = list(graph_trace)

        invocation_state["planning_output"] = final_output.model_dump()
        invocation_state["planning_output_obj"] = final_output
        invocation_state["day_details_list"] = [d.model_dump() for d in day_details]

        elapsed = time.time() - start
        logger.info(
            "AggregateDaysNode completed in %.2fs (%d days)",
            elapsed,
            len(day_details),
        )
        output_text = json.dumps(
            {"aggregated_days": len(day_details)}, ensure_ascii=False
        )
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={
                "aggregate_days": NodeResult(
                    result=_make_agent_result(output_text),
                    status=Status.COMPLETED,
                    execution_time=int(elapsed * 1000),
                )
            },
        )


# ---------------------------------------------------------------------------
# Node 5d: Synthesize (post-aggregate copywriting)
# ---------------------------------------------------------------------------
class SynthesizeNode(MultiAgentBase):
    """LLM copywriter that runs after :class:`AggregateDaysNode`.

    Receives the merged ``PlanningOutput`` (cities, hotels, flights,
    full itinerary) plus user intent and reference data, and rewrites:
    package_name, description, hashtags, highlights, changes_summary.

    The agent is forbidden from changing any factual content
    (cities/hotels/itinerary) — those are already validated grounded
    decisions from the upstream graph. Failures fall back to the
    placeholder values written by ``merge_skeleton_and_days``.
    """

    def __init__(self) -> None:
        super().__init__()
        self._agent = None  # lazy

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        start = time.time()
        invocation_state = invocation_state or {}

        output_data = invocation_state.get("planning_output")
        if not isinstance(output_data, dict):
            logger.warning(
                "SynthesizeNode: no planning_output found, skipping copy rewrite"
            )
            return self._completed_result(start, "no_output")

        try:
            output_obj = PlanningOutput(**output_data)
        except Exception as e:  # noqa: BLE001
            logger.warning("SynthesizeNode: PlanningOutput parse failed: %s", e)
            return self._completed_result(start, "parse_error")

        prompt = self._build_prompt(output_obj, invocation_state)

        try:
            if self._agent is None:
                from src.agents.synthesize import create_synthesize_agent
                self._agent = create_synthesize_agent()
            result = await asyncio.to_thread(self._agent, prompt)
            synth = result.structured_output
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "SynthesizeNode: LLM call failed (%s) — keeping placeholders", e
            )
            return self._completed_result(start, "llm_error")

        # Splat LLM-written fields onto the merged output.
        if getattr(synth, "package_name", None):
            output_obj.package_name = synth.package_name
        output_obj.description = getattr(synth, "description", "") or output_obj.description
        if getattr(synth, "hashtags", None):
            output_obj.hashtags = list(synth.hashtags)
        if getattr(synth, "highlights", None):
            output_obj.highlights = list(synth.highlights)[:10]
        # Stage 4: pricing / inclusions / exclusions / optional_costs are
        # day-aware judgment fields. Take what the LLM wrote whenever it
        # produced something non-empty; otherwise the placeholder from
        # merge_skeleton_and_days (Pricing(), []) stays.
        synth_pricing = getattr(synth, "pricing", None)
        if synth_pricing is not None and getattr(synth_pricing, "adult_price", 0):
            output_obj.pricing = synth_pricing
        if getattr(synth, "inclusions", None):
            output_obj.inclusions = list(synth.inclusions)
        if getattr(synth, "exclusions", None):
            output_obj.exclusions = list(synth.exclusions)
        if getattr(synth, "optional_costs", None):
            output_obj.optional_costs = list(synth.optional_costs)

        # changes_summary: keep code-derived trend_added & similarity_applied,
        # accept LLM's retained / modified / layers_modified narrative.
        if getattr(synth, "changes_summary", None) is not None:
            cs = synth.changes_summary
            existing = output_obj.changes_summary
            output_obj.changes_summary = ChangesSummary(
                retained=list(cs.retained or existing.retained),
                modified=list(cs.modified or existing.modified),
                trend_added=list(existing.trend_added),  # code-authoritative
                similarity_applied=existing.similarity_applied,  # code-authoritative
                layers_modified=list(cs.layers_modified or existing.layers_modified),
            )

        invocation_state["planning_output"] = output_obj.model_dump()
        invocation_state["planning_output_obj"] = output_obj

        return self._completed_result(start, "ok")

    @staticmethod
    def _build_prompt(output: "PlanningOutput", invocation_state: dict) -> str:
        """Render a compact synth prompt — itinerary + intent + reference."""
        planning_input = invocation_state.get("planning_input_parsed", {}) or {}
        ref_data = invocation_state.get("reference_retain_data", {}) or {}
        achieved_breakdown = output.similarity_breakdown or {}

        skeleton_summary = {
            "cities": output.city_list,
            "hotels": output.hotels,
            "departure": {
                "airline": output.airline,
                "flight": output.departure_flight.flight_number,
                "arrival_time": output.departure_flight.arrival_time,
            },
            "return": {
                "flight": output.return_flight.flight_number,
                "departure_time": output.return_flight.departure_time,
            },
            "brand": output.brand,
        }
        itinerary_summary = [
            {
                "day": d.day,
                "date": d.date,
                "cities": d.cities,
                "attractions": d.attractions,
            }
            for d in output.itinerary
        ]
        intent = {
            "themes": planning_input.get("themes") or [],
            "season": planning_input.get("departure_season"),
            "similarity_level": planning_input.get("similarity_level"),
            "natural_language_request": planning_input.get(
                "natural_language_request", ""
            ),
            "target_customer": planning_input.get("target_customer", ""),
        }
        ref_summary = {
            "cities": ref_data.get("cities") or [],
            "hotels": ref_data.get("hotels") or [],
            "attractions": ref_data.get("attractions") or [],
        }

        parts = [
            "## skeleton",
            json.dumps(skeleton_summary, ensure_ascii=False, default=str),
            "",
            "## itinerary (확정)",
            json.dumps(itinerary_summary, ensure_ascii=False, default=str),
            "",
            "## planning_input (사용자 의도)",
            json.dumps(intent, ensure_ascii=False, default=str),
            "",
            "## reference_summary (비교 대상)",
            json.dumps(ref_summary, ensure_ascii=False, default=str),
            "",
            "## achieved_similarity (코드 측정값)",
            json.dumps(
                {
                    "score": output.achieved_similarity,
                    "breakdown": achieved_breakdown,
                },
                ensure_ascii=False,
                default=str,
            ),
        ]
        return "\n".join(parts)

    def _completed_result(self, start: float, mode: str) -> MultiAgentResult:
        elapsed = time.time() - start
        logger.info("SynthesizeNode completed in %.2fs (%s)", elapsed, mode)
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={
                "synthesize": NodeResult(
                    result=_make_agent_result(
                        json.dumps({"mode": mode}, ensure_ascii=False)
                    ),
                    status=Status.COMPLETED,
                    execution_time=int(elapsed * 1000),
                )
            },
        )


# ---------------------------------------------------------------------------
# Node 6: Validate Day Details (per-day + cross-day)
# ---------------------------------------------------------------------------
class ValidateDayDetailsNode(MultiAgentBase):
    """Validate merged PlanningOutput: per-day + cross-day checks."""

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        start = time.time()
        invocation_state = invocation_state or {}

        output_obj = invocation_state.get("planning_output_obj")
        if output_obj is None:
            output_data = invocation_state.get("planning_output")
            if output_data:
                output_obj = PlanningOutput(**output_data)
            else:
                raise RuntimeError("ValidateDayDetailsNode: no PlanningOutput found")

        validation = validate_itinerary(output_obj)

        # Graph-grounded city-scope check via MCP (Lambda → Neptune).
        # Direct boto3 calls from the agent runtime would block until
        # Neptune connect timeout (~5min) since Runtime is on PUBLIC
        # network and Neptune lives in VPC.
        try:
            day_attrs = {
                str(d.day): list(d.attractions or []) for d in output_obj.itinerary
            }
            day_cities = {
                str(d.day): [c.strip() for c in (d.cities or "").split(",") if c.strip()]
                for d in output_obj.itinerary
            }
            mcp = get_mcp_client()
            scope_result = await asyncio.to_thread(
                mcp.call_tool_sync,
                tool_use_id="validate-city-scope-1",
                name=prefixed("validate_city_scope"),
                arguments={"day_attractions": day_attrs, "day_cities": day_cities},
            )
            scope_payload = None
            if hasattr(scope_result, "content") and scope_result.content:
                for block in scope_result.content:
                    if hasattr(block, "text"):
                        try:
                            scope_payload = json.loads(block.text)
                            break
                        except (json.JSONDecodeError, TypeError):
                            pass
            if scope_payload:
                from src.validator.itinerary_validator import (
                    issues_from_city_scope_response,
                )
                extra_issues = issues_from_city_scope_response(output_obj, scope_payload)
                if extra_issues:
                    validation.issues.extend(extra_issues)
                    error_count = sum(
                        1 for i in validation.issues if i.severity.value == "ERROR"
                    )
                    warning_count = sum(
                        1 for i in validation.issues if i.severity.value == "WARNING"
                    )
                    validation.score = max(
                        0, 100 - (error_count * 15) - (warning_count * 5)
                    )
                    validation.passed = validation.score >= 70
        except Exception as scope_err:
            logger.warning("city_scope MCP validation skipped: %s", scope_err)

        retry_count = invocation_state.get("day_retry_count", 0)

        if validation.passed:
            invocation_state["validation_passed"] = True
            invocation_state["days_need_retry"] = False
            invocation_state["validation_result"] = validation.model_dump()
            invocation_state["failed_days"] = []
            status_msg = f"DAYS_PASS (score={validation.score})"
        elif retry_count < 3:
            invocation_state["validation_passed"] = False
            invocation_state["days_need_retry"] = True
            invocation_state["day_retry_count"] = retry_count + 1
            invocation_state["validation_result"] = validation.model_dump()

            # Identify which days failed
            failed = set()
            for issue in validation.issues:
                if hasattr(issue, "day") and issue.day:
                    failed.add(issue.day)
            invocation_state["failed_days"] = list(failed) if failed else list(range(1, output_obj.days + 1))

            # Store per-day correction guides
            for day_num in invocation_state["failed_days"]:
                day_issues = [i for i in validation.issues if getattr(i, "day", None) == day_num]
                if day_issues:
                    guide = "\n".join(f"- {i.message}" for i in day_issues)
                    invocation_state[f"day_{day_num}_correction"] = guide

            status_msg = f"DAYS_FAIL (score={validation.score}, retry {retry_count + 1}/3, failed_days={invocation_state['failed_days']})"
        else:
            invocation_state["validation_passed"] = True
            invocation_state["days_need_retry"] = False
            invocation_state["validation_result"] = validation.model_dump()
            invocation_state["failed_days"] = []
            status_msg = f"DAYS_PASS_WITH_WARNINGS (score={validation.score})"

        elapsed = time.time() - start
        logger.info("ValidateDayDetailsNode completed in %.2fs -- %s", elapsed, status_msg)

        output_text = json.dumps({"status": status_msg, "validation": validation.model_dump()}, ensure_ascii=False, default=str)
        agent_result = _make_agent_result(output_text)
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={"validate_day_details": NodeResult(result=agent_result, status=Status.COMPLETED, execution_time=int(elapsed * 1000))},
        )
