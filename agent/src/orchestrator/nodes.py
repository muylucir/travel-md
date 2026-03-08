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
from src.similarity.layer_rules import format_rules_for_prompt, compute_change_rules
from src.validator.itinerary_validator import validate_itinerary, validate_skeleton
from src.cache import get_cache
from src.mcp_connection import get_mcp_client, prefixed

logger = logging.getLogger(__name__)


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

    Collects: reference package, similar packages, routes, trends,
    attractions, hotels. All calls go through AgentCore Gateway MCP
    instead of direct Gremlin connections.
    """

    def __init__(self) -> None:
        super().__init__()

    @staticmethod
    def _collect_context_via_mcp(planning_input: dict) -> dict:
        """Call graph tools via MCP Gateway synchronously.

        The MCP client is auto-started by get_mcp_client(), so no context
        manager is needed.  call_tool_sync signature:
            call_tool_sync(tool_use_id, name, arguments)
        """
        mcp = get_mcp_client()

        destination = planning_input.get("destination", "")
        season = planning_input.get("departure_season", "")
        nights = planning_input.get("duration", {}).get("nights", 0)
        themes = planning_input.get("themes", [])
        max_budget = planning_input.get("max_budget_per_person")
        shopping_max = planning_input.get("max_shopping_count")
        reference_id = planning_input.get("reference_product_id")
        dest_parts = destination.split() if destination else []
        region = dest_parts[-1] if dest_parts else destination
        city_hint = dest_parts[-1] if dest_parts else destination

        context_parts: dict = {}
        _call_id = 0

        cache = get_cache()

        def _safe_call(key: str, tool_name: str, arguments: dict):
            nonlocal _call_id
            _call_id += 1

            cached = cache.get(tool_name, arguments)
            if cached is not None:
                context_parts[key] = cached
                return

            try:
                result = mcp.call_tool_sync(
                    tool_use_id=f"ctx-{_call_id}",
                    name=prefixed(tool_name),
                    arguments=arguments,
                )
                context_parts[key] = result
                cache.set(tool_name, arguments, result)
            except Exception as e:
                logger.warning("MCP call failed %s/%s: %s", key, tool_name, e)

        if reference_id:
            _safe_call("reference_package", "get_package", {"package_code": reference_id})

        theme_str = themes[0] if themes else ""
        search_args = {"destination": region, "theme": theme_str, "season": season, "nights": nights}
        if max_budget:
            search_args["max_budget"] = max_budget
        if shopping_max is not None:
            search_args["shopping_max"] = shopping_max
        _safe_call("search_results", "search_packages", search_args)

        _safe_call("routes", "get_routes_by_region", {"region": region})
        _safe_call("trends", "get_trends", {"region": region, "min_score": 30})

        if reference_id:
            _safe_call("similar_packages", "get_similar_packages", {"package_code": reference_id})

        # --- Region resolution fallback ---
        # If routes came back empty, region might be a city name (e.g., "오사카")
        # Try to resolve the actual region via get_nearby_cities
        routes_result = context_parts.get("routes")
        routes_empty = not routes_result or (
            isinstance(routes_result, str) and '"count": 0' in routes_result
        )
        if routes_empty and city_hint:
            _safe_call("_city_info", "get_nearby_cities", {"city": city_hint, "max_km": 0})
            city_info = context_parts.pop("_city_info", None)
            if city_info:
                # Parse region from nearby_cities response
                info_str = str(city_info)
                region_match = re.search(r'"region":\s*"([^"]+)"', info_str)
                if region_match and region_match.group(1) != region:
                    region = region_match.group(1)
                    _safe_call("routes", "get_routes_by_region", {"region": region})
                    _safe_call("trends", "get_trends", {"region": region, "min_score": 30})

        # --- Per-city attraction and hotel pre-fetch ---
        cities_to_query: set = set()

        # Extract cities from search results
        sr = context_parts.get("search_results")
        if sr:
            sr_str = str(sr)
            for field in ("city_list", "travel_cities"):
                for m in re.finditer(rf'"{field}":\s*\[([^\]]*)\]', sr_str):
                    for city_m in re.finditer(r'"([^"]+)"', m.group(1)):
                        cities_to_query.add(city_m.group(1))

        # Extract cities from reference package
        rp = context_parts.get("reference_package")
        if rp:
            rp_str = str(rp)
            for m in re.finditer(r'"name":\s*"([^"]+)"', rp_str):
                name = m.group(1)
                if len(name) <= 8 and not any(c.isdigit() for c in name):
                    cities_to_query.add(name)

        if city_hint:
            cities_to_query.add(city_hint)

        # Remove departure cities
        DEPARTURE = {"인천", "김포", "부산", "대구", "제주", "청주", "무안", "양양"}
        cities_to_query -= DEPARTURE

        # Fetch attractions and hotels for top 5 cities
        city_attractions: dict = {}
        city_hotels: dict = {}
        for cname in list(cities_to_query)[:5]:
            key_a = f"_attr_{cname}"
            key_h = f"_hotel_{cname}"
            _safe_call(key_a, "get_attractions_by_city", {"city": cname})
            _safe_call(key_h, "get_hotels_by_city", {"city": cname})
            result_a = context_parts.pop(key_a, None)
            result_h = context_parts.pop(key_h, None)
            if result_a:
                city_attractions[cname] = result_a
            if result_h:
                city_hotels[cname] = result_h

        if city_attractions:
            context_parts["city_attractions"] = city_attractions
        if city_hotels:
            context_parts["city_hotels"] = city_hotels

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
        rules_prompt = invocation_state.get("similarity_rules_prompt", "")
        correction_guide = invocation_state.get("skeleton_correction_guide", "")
        retry_count = invocation_state.get("skeleton_retry_count", 0)

        parts = [
            "## 기획 요청",
            json.dumps(planning_input, ensure_ascii=False, default=str),
            "",
            rules_prompt,
            "",
            "## Graph 컨텍스트",
            json.dumps(graph_context, ensure_ascii=False, default=str),
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

        invocation_state["skeleton_output"] = skeleton.model_dump()
        invocation_state["skeleton_output_obj"] = skeleton

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
    def _compute_max_attractions(day_num: int, total_days: int, skeleton) -> int:
        if day_num == 1:
            try:
                arr_h, _ = map(int, skeleton.departure_flight.arrival_time.split(":"))
                available_hours = max(0, 22 - (arr_h + 3))
            except (ValueError, AttributeError):
                available_hours = 4
            return max(1, int(available_hours / 2))
        elif day_num == total_days:
            try:
                dep_h, _ = map(int, skeleton.return_flight.departure_time.split(":"))
                available_hours = max(0, (dep_h - 3) - 9)
            except (ValueError, AttributeError):
                available_hours = 3
            return max(1, int(available_hours / 2))
        else:
            return 6

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

            max_attr = self._compute_max_attractions(day_alloc.day, skeleton.days, skeleton)

            parts = [
                f"## {day_alloc.day}일차 상세 기획",
                f"- 날짜: {day_alloc.date} ({day_alloc.day_of_week})",
                f"- 도시: {day_alloc.cities}",
                f"- 숙소: {skeleton.hotels[day_alloc.day - 1] if day_alloc.day <= len(skeleton.hotels) else '(귀국일)'}",
                f"- 항공편: 출발편 도착 {skeleton.departure_flight.arrival_time} / 귀국편 출발 {skeleton.return_flight.departure_time}",
                f"- 전체 일정: {skeleton.days}일 중 {day_alloc.day}일차",
                f"- **관광지 상한: {max_attr}개** (절대 초과 금지)",
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
                "## Graph 컨텍스트",
                json.dumps(graph_context, ensure_ascii=False, default=str),
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

        final_output = merge_skeleton_and_days(skeleton, day_details)

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
