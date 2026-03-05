"""BedrockAgentCoreApp entrypoint.

Provides the ``handler`` function that AgentCore Runtime invokes.
Yields SSE-style progress events and a final result event.

Tools are accessed via AgentCore Gateway MCP -- no direct Neptune/DynamoDB
connections from the Runtime container.
"""

from __future__ import annotations

import json
import logging
import time

from src.models.input import PlanningInput
from src.models.output import PlanningOutput
from src.orchestrator.graph import create_planning_graph
from src.mcp_connection import get_mcp_client, prefixed

logger = logging.getLogger(__name__)

# Lazy-init graph
_graph = None


def _get_graph():
    global _graph
    if _graph is None:
        _graph = create_planning_graph()
    return _graph


async def handler(input_data: dict, **kwargs):
    """AgentCore Runtime handler -- async generator yielding SSE events.

    Parameters
    ----------
    input_data:
        JSON body from the caller, expected to conform to PlanningInput.

    Yields
    ------
    dict events in the form::

        {"event": "progress", "data": {"step": "...", "percent": N}}
        {"event": "result",   "data": PlanningOutput as dict}
        {"event": "error",    "data": {"message": "..."}}
    """
    start_time = time.time()

    try:
        # Parse input
        yield {"event": "progress", "data": {"step": "입력 파싱 중...", "percent": 5}}

        planning_input = PlanningInput(**input_data)

        # Build invocation state
        invocation_state = {
            "planning_input": planning_input.model_dump(),
        }

        yield {"event": "progress", "data": {"step": "컨텍스트 수집 중...", "percent": 15}}

        # Execute the planning graph
        graph = _get_graph()

        # We run the graph and stream events
        yield {"event": "progress", "data": {"step": "일정 생성 중...", "percent": 30}}

        result = await graph.invoke_async(
            json.dumps(planning_input.model_dump(), ensure_ascii=False),
            invocation_state,
        )

        yield {"event": "progress", "data": {"step": "검증 중...", "percent": 80}}

        # Extract the final output from invocation_state or graph results
        planning_output_data = invocation_state.get("planning_output")

        if planning_output_data:
            output = PlanningOutput(**planning_output_data)
        else:
            # Fallback: try to extract from the last node result
            validate_result = result.results.get("validate")
            if validate_result and validate_result.result:
                output_text = str(validate_result.result)
                try:
                    parsed = json.loads(output_text)
                    output = PlanningOutput(**parsed.get("planning_output", parsed))
                except (json.JSONDecodeError, TypeError):
                    raise RuntimeError("Failed to extract PlanningOutput from graph result")
            else:
                raise RuntimeError("No planning output produced by the graph")

        elapsed = time.time() - start_time
        logger.info("Planning completed in %.2fs", elapsed)

        # Save to DynamoDB via MCP Gateway
        yield {"event": "progress", "data": {"step": "상품 저장 중...", "percent": 90}}
        try:
            product_json = output.model_dump_json()
            mcp = get_mcp_client()
            mcp.call_tool_sync(
                tool_use_id="save-product-1",
                name=prefixed("save_product"),
                arguments={"product_json": product_json},
            )
            logger.info("Saved product via MCP Gateway")
        except Exception as save_err:
            logger.warning("Failed to save product via MCP: %s", save_err)

        yield {"event": "progress", "data": {"step": "완료", "percent": 100}}

        # Yield validation info if available
        validation_result = invocation_state.get("validation_result")
        if validation_result:
            yield {
                "event": "validation",
                "data": validation_result,
            }

        # Final result
        yield {
            "event": "result",
            "data": output.model_dump(),
        }

    except Exception as e:
        logger.exception("Planning handler failed")
        yield {
            "event": "error",
            "data": {"message": str(e)},
        }
