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
from datetime import datetime, timezone

from strands.agent.agent_result import AgentResult
from strands.multiagent.base import MultiAgentBase, MultiAgentResult, NodeResult, Status
from strands.types.content import ContentBlock, Message

from src.agents.chat_parser import create_chat_parser_agent
from src.agents.itinerary import create_itinerary_agent
from src.models.input import PlanningInput
from src.models.output import PlanningOutput
from src.similarity.layer_rules import format_rules_for_prompt, compute_change_rules
from src.validator.itinerary_validator import validate_itinerary
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
        region = destination.split()[-1] if destination else destination

        context_parts: dict = {}
        _call_id = 0

        def _safe_call(key: str, tool_name: str, arguments: dict):
            nonlocal _call_id
            _call_id += 1
            try:
                result = mcp.call_tool_sync(
                    tool_use_id=f"ctx-{_call_id}",
                    name=prefixed(tool_name),
                    arguments=arguments,
                )
                context_parts[key] = result
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
