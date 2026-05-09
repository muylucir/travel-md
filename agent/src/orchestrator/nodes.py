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
from src.agents.itinerary import create_itinerary_agent
from src.agents.skeleton import create_skeleton_agent
from src.agents.day_detail import create_day_detail_agent
from src.models.input import PlanningInput
from src.models.output import (
    PlanningOutput,
    SkeletonOutput,
    DayDetailOutput,
    merge_skeleton_and_days,
)
from src.similarity.layer_rules import (
    format_rules_for_prompt,
    compute_change_rules,
    extract_reference_data,
)
from src.validator.itinerary_validator import validate_itinerary, validate_skeleton
from src.cache import get_cache
from src.mcp_connection import get_mcp_client, prefixed

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
# Node 3: Generate Itinerary
# ---------------------------------------------------------------------------
class GenerateItineraryNode(MultiAgentBase):
    """Invoke the Itinerary Agent (Opus) with context and rules to generate a PlanningOutput."""

    def __init__(self) -> None:
        super().__init__()
        self._agent = None  # lazy init

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        start = time.time()
        invocation_state = invocation_state or {}

        if self._agent is None:
            self._agent = create_itinerary_agent()

        planning_input = invocation_state.get("planning_input_parsed", {})
        graph_context = invocation_state.get("graph_context", {})
        rules_prompt = invocation_state.get("similarity_rules_prompt", "")
        correction_guide = invocation_state.get("correction_guide", "")
        retry_count = invocation_state.get("retry_count", 0)

        # Build the user message
        parts = [
            "## 기획 요청",
            json.dumps(planning_input, ensure_ascii=False, default=str),
            "",
            rules_prompt,
            "",
            "## Graph 컨텍스트 (Knowledge Graph 조회 결과)",
            json.dumps(graph_context, ensure_ascii=False, default=str),
        ]

        if correction_guide:
            parts.extend([
                "",
                f"## 이전 검증 실패 (재시도 {retry_count}/3)",
                correction_guide,
                "",
                "위 문제를 수정하여 다시 일정을 생성하세요.",
            ])

        user_message = "\n".join(parts)

        # Invoke the itinerary agent
        result = self._agent(user_message)
        output: PlanningOutput = result.structured_output

        # product_code and generated_at are server-generated on save (Lambda)

        # Store output in state
        invocation_state["planning_output"] = output.model_dump()
        invocation_state["planning_output_obj"] = output

        output_text = output.model_dump_json(ensure_ascii=False)

        elapsed = time.time() - start
        logger.info("GenerateItineraryNode completed in %.2fs", elapsed)

        agent_result = _make_agent_result(output_text)
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={"generate_itinerary": NodeResult(result=agent_result, status=Status.COMPLETED, execution_time=int(elapsed * 1000))},
        )


# ---------------------------------------------------------------------------
# Node 4: Validate
# ---------------------------------------------------------------------------
class ValidateNode(MultiAgentBase):
    """Run programmatic validation on the generated itinerary.

    Sets state flags for the conditional edges:
    - validation_passed: True/False
    - needs_retry: True if failed and retries remain
    """

    def __init__(self) -> None:
        super().__init__()

    @staticmethod
    def _extract_planning_output_from_text(text: str) -> PlanningOutput | None:
        """Try to extract a PlanningOutput JSON from node output text.

        The task text passed by GraphBuilder contains formatted results from
        upstream nodes. We look for a JSON object containing 'package_name'
        which is a required field of PlanningOutput.
        """
        if not text:
            return None
        # Find JSON objects in the text by looking for balanced braces
        # containing the key marker "package_name"
        for match in re.finditer(r'\{', text):
            start_idx = match.start()
            # Quick check: does the rest contain our marker?
            remainder = text[start_idx:]
            if '"package_name"' not in remainder[:5000]:
                continue
            # Try increasingly large slices to find valid JSON
            depth = 0
            for i, ch in enumerate(remainder):
                if ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        candidate = remainder[:i + 1]
                        try:
                            data = json.loads(candidate)
                            if isinstance(data, dict) and "package_name" in data:
                                logger.info("ValidateNode: successfully parsed PlanningOutput from task text")
                                return PlanningOutput(**data)
                        except (json.JSONDecodeError, Exception):
                            pass
                        break
        return None

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        start = time.time()
        invocation_state = invocation_state or {}

        # Try multiple sources for the PlanningOutput:
        # 1. invocation_state (direct object)
        # 2. invocation_state (serialized dict)
        # 3. task text from previous node output (JSON fallback)
        output_obj = invocation_state.get("planning_output_obj")

        if output_obj is None:
            output_data = invocation_state.get("planning_output")
            if output_data and isinstance(output_data, dict) and len(output_data) > 0:
                logger.info("ValidateNode: loading PlanningOutput from invocation_state dict")
                output_obj = PlanningOutput(**output_data)

        if output_obj is None:
            # Fallback: parse from the task text (previous node's AgentResult text)
            task_str = str(task) if task else ""
            logger.info("ValidateNode: attempting to parse PlanningOutput from task text (%d chars)", len(task_str))
            # The task text may contain structured node output with JSON
            # Try to extract a JSON object that looks like PlanningOutput
            parsed = self._extract_planning_output_from_text(task_str)
            if parsed is not None:
                output_obj = parsed
            else:
                raise RuntimeError(
                    "ValidateNode: could not find PlanningOutput in invocation_state or task text"
                )

        validation = validate_itinerary(output_obj)
        retry_count = invocation_state.get("retry_count", 0)

        if validation.passed:
            invocation_state["validation_passed"] = True
            invocation_state["needs_retry"] = False
            invocation_state["validation_result"] = validation.model_dump()
            status_msg = f"PASS (score={validation.score})"
        elif retry_count < 3:
            invocation_state["validation_passed"] = False
            invocation_state["needs_retry"] = True
            invocation_state["retry_count"] = retry_count + 1
            invocation_state["correction_guide"] = validation.correction_guide
            invocation_state["validation_result"] = validation.model_dump()
            status_msg = f"FAIL (score={validation.score}, retry {retry_count + 1}/3)"
        else:
            # Max retries reached -- pass with warnings
            invocation_state["validation_passed"] = True
            invocation_state["needs_retry"] = False
            invocation_state["validation_result"] = validation.model_dump()
            invocation_state["passed_with_warnings"] = True
            status_msg = f"PASS_WITH_WARNINGS (score={validation.score}, max retries)"

        elapsed = time.time() - start
        logger.info("ValidateNode completed in %.2fs -- %s", elapsed, status_msg)

        output_text = json.dumps({
            "status": status_msg,
            "validation": validation.model_dump(),
        }, ensure_ascii=False, default=str)

        agent_result = _make_agent_result(output_text)
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={"validate": NodeResult(result=agent_result, status=Status.COMPLETED, execution_time=int(elapsed * 1000))},
        )


# ---------------------------------------------------------------------------
# Node 5: Generate Skeleton (Phase 1 — Sonnet, fast)
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

        # ── 유사도 강제 후처리 ──────────────────────────────────────────────
        # similarity 가 retain 으로 판정한 layer 의 값을 reference 와 일치시킨다.
        # LLM 이 무시한 경우에도 코드 레벨에서 강제 일치시켜 입력 의도를 보장.
        rules = compute_change_rules(similarity)
        if ref_data:
            if rules.get("route") == "retain":
                if ref_data.get("cities"):
                    skeleton.city_list = list(ref_data["cities"])
                    skeleton.travel_cities = "-".join(ref_data["cities"])
            if rules.get("hotel") == "retain":
                if ref_data.get("hotels"):
                    skeleton.hotels = list(ref_data["hotels"])
            # attractions/activities 는 day_detail 단계에서 처리

        invocation_state["skeleton_output"] = skeleton.model_dump()
        invocation_state["skeleton_output_obj"] = skeleton
        invocation_state["similarity_rules"] = rules
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
# Node 6: Validate Skeleton
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
# Node 7: Generate Day Details (Phase 2 — Opus, parallel per day)
# ---------------------------------------------------------------------------
class GenerateDayDetailsNode(MultiAgentBase):
    """Phase 2: Fill in per-day attractions, meals, activities.

    Days are generated in parallel via ``asyncio.gather`` with separate
    Agent instances.  To prevent duplicate attractions across days in the
    same city, attractions from graph_context are pre-partitioned and each
    day receives only its assigned subset.  The existing
    ``ValidateDayDetailsNode`` catches any remaining duplicates.
    """

    def __init__(self) -> None:
        super().__init__()

    @staticmethod
    def _compute_time_budget(
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

    # Backward-compat thin shim
    @staticmethod
    def _compute_max_attractions(day_num: int, total_days: int, skeleton) -> int:
        return GenerateDayDetailsNode._compute_time_budget(
            day_num, total_days, skeleton, num_cities=1
        )["max_attractions"]

    @staticmethod
    def _partition_attractions(sorted_allocs, graph_context: dict) -> dict[int, list[str]]:
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

    async def invoke_async(self, task, invocation_state=None, **kwargs):
        start = time.time()
        invocation_state = invocation_state or {}

        skeleton_data = invocation_state.get("skeleton_output")
        skeleton = SkeletonOutput(**skeleton_data) if skeleton_data else invocation_state.get("skeleton_output_obj")
        graph_context = invocation_state.get("graph_context", {})
        rules_prompt = invocation_state.get("similarity_rules_prompt", "")
        failed_days = invocation_state.get("failed_days", [])

        existing_details = invocation_state.get("day_details_list", [])
        existing_by_day = {d["day"]: d for d in existing_details}

        sorted_allocs = sorted(skeleton.day_allocations, key=lambda d: d.day)

        # Pre-partition attractions to eliminate sequential dependency
        day_attractions = self._partition_attractions(sorted_allocs, graph_context)

        # Collect already-confirmed attractions from existing (passed) days
        existing_attractions: list[str] = []
        for alloc in sorted_allocs:
            if failed_days and alloc.day not in failed_days and alloc.day in existing_by_day:
                existing = DayDetailOutput(**existing_by_day[alloc.day])
                existing_attractions.extend(existing.attractions)

        # Build prompts and identify days that need generation
        generation_tasks: list[tuple[int, str]] = []  # (day_num, prompt)

        for idx, day_alloc in enumerate(sorted_allocs):
            if failed_days and day_alloc.day not in failed_days and day_alloc.day in existing_by_day:
                continue

            prev_last_city = ""
            if idx > 0:
                prev_cities = sorted_allocs[idx - 1].cities
                prev_last_city = [c.strip() for c in prev_cities.split(",") if c.strip()][-1] if prev_cities else ""

            next_first_city = ""
            if idx < len(sorted_allocs) - 1:
                next_cities = sorted_allocs[idx + 1].cities
                next_first_city = [c.strip() for c in next_cities.split(",") if c.strip()][0] if next_cities else ""

            day_city_list = [
                c.strip() for c in day_alloc.cities.split(",") if c.strip()
            ]
            budget = self._compute_time_budget(
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

            # Assigned attractions for this day (pre-partitioned to avoid duplicates)
            assigned = day_attractions.get(day_alloc.day, [])
            # Other days' attractions to avoid
            other_days_attractions = existing_attractions.copy()
            for other_day, other_list in day_attractions.items():
                if other_day != day_alloc.day:
                    other_days_attractions.extend(other_list)

            parts.extend([
                "",
                rules_prompt,
                "",
                "## 이 일차에 배정된 추천 관광지",
                ", ".join(assigned) if assigned else "(자유 선택)",
                "",
                "## 다른 일차 관광지 (중복 금지)",
                ", ".join(set(other_days_attractions)) if other_days_attractions else "(없음)",
                "",
                "## Graph 컨텍스트 (이 일차 도시 관련만)",
                json.dumps(_build_day_context(graph_context, [c.strip() for c in day_alloc.cities.split(",") if c.strip()], day_alloc.day), ensure_ascii=False, default=str),
            ])

            correction = invocation_state.get(f"day_{day_alloc.day}_correction", "")
            if correction:
                parts.extend(["", "## 이전 검증 실패", correction, "위 문제를 수정하세요."])

            generation_tasks.append((day_alloc.day, "\n".join(parts)))

        # --- Parallel generation with separate Agent instances ---
        async def _generate_day(day_num: int, prompt: str) -> DayDetailOutput:
            agent = create_day_detail_agent()
            result = await asyncio.to_thread(agent, prompt)
            detail: DayDetailOutput = result.structured_output
            for alloc in sorted_allocs:
                if alloc.day == day_num:
                    detail.day = alloc.day
                    detail.date = alloc.date
                    detail.day_of_week = alloc.day_of_week
                    detail.cities = alloc.cities
                    break
            logger.info("Day %d detail generated", day_num)
            return detail

        generated: dict[int, DayDetailOutput] = {}
        if generation_tasks:
            logger.info("Generating %d day details in parallel...", len(generation_tasks))
            results = await asyncio.gather(
                *[_generate_day(dn, p) for dn, p in generation_tasks],
                return_exceptions=True,
            )
            for (day_num, _), result in zip(generation_tasks, results):
                if isinstance(result, Exception):
                    logger.error("Day %d generation failed: %s", day_num, result)
                    raise result
                generated[day_num] = result

        # Merge: existing (passed) days + newly generated days, sorted by day
        day_details = []
        for alloc in sorted_allocs:
            if alloc.day in generated:
                day_details.append(generated[alloc.day])
            elif alloc.day in existing_by_day:
                day_details.append(DayDetailOutput(**existing_by_day[alloc.day]))

        # ── 유사도 강제: attraction(L3) retain 시 reference 명소 보장 ─────
        ref_data = invocation_state.get("reference_retain_data") or {}
        rules = invocation_state.get("similarity_rules") or {}
        if rules.get("attraction") == "retain" and ref_data.get("attractions"):
            ref_attrs = list(ref_data["attractions"])
            existing_names: set[str] = set()
            for d in day_details:
                for n in d.attractions:
                    existing_names.add(n)
            missing = [n for n in ref_attrs if n not in existing_names]
            # 누락된 reference 명소를 마지막 day 의 attractions 끝에 보강한다.
            if missing and day_details:
                target = day_details[-1]
                for n in missing:
                    if n not in target.attractions:
                        target.attractions.append(n)
                logger.info(
                    "Retain L3 attraction: appended %d missing reference attractions",
                    len(missing),
                )

        final_output = merge_skeleton_and_days(skeleton, day_details)

        # ── similarity_score 보정: 사용자 요청값으로 강제 동기화 ─────────
        # LLM 이 PlanningOutput.similarity_score 를 임의로 채울 수 있으므로
        # 사용자가 슬라이더에 입력한 similarity_level 로 덮어쓴다.
        planning_input_dict = invocation_state.get("planning_input_parsed", {})
        target_similarity = int(planning_input_dict.get("similarity_level", 50))
        final_output.similarity_score = target_similarity
        if final_output.changes_summary is not None:
            final_output.changes_summary.similarity_applied = target_similarity
            modified_layers = [
                layer for layer, decision in (rules or {}).items() if decision == "modify"
            ]
            if modified_layers:
                final_output.changes_summary.layers_modified = modified_layers

        # ── graph_trace 주입 ────────────────────────────────────────────
        graph_trace = invocation_state.get("graph_trace") or []
        if graph_trace:
            final_output.graph_trace = list(graph_trace)

        invocation_state["planning_output"] = final_output.model_dump()
        invocation_state["planning_output_obj"] = final_output
        invocation_state["day_details_list"] = [d.model_dump() for d in day_details]

        output_text = json.dumps({"days_generated": len(generation_tasks)}, ensure_ascii=False)
        elapsed = time.time() - start
        logger.info("GenerateDayDetailsNode completed in %.2fs (%d days, parallel)", elapsed, len(generation_tasks))

        agent_result = _make_agent_result(output_text)
        return MultiAgentResult(
            status=Status.COMPLETED,
            results={"generate_day_details": NodeResult(result=agent_result, status=Status.COMPLETED, execution_time=int(elapsed * 1000))},
        )


# ---------------------------------------------------------------------------
# Node 8: Validate Day Details (per-day + cross-day)
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
