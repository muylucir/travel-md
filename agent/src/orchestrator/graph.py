"""Planning Orchestrator -- Strands GraphBuilder DAG.

DAG topology::

    parse_input -> collect_context -> generate_itinerary -> validate
    validate -> generate_itinerary   (conditional: retry on failure, max 3)
    validate -> (end)                (conditional: on pass)
"""

from __future__ import annotations

import logging

from strands.multiagent.graph import GraphBuilder, GraphState
from strands.multiagent.base import Status

from src.orchestrator.nodes import (
    ParseInputNode,
    CollectContextNode,
    GenerateItineraryNode,
    ValidateNode,
)

logger = logging.getLogger(__name__)


def _needs_retry(state: GraphState) -> bool:
    """Conditional edge: route back to generate_itinerary if validation failed and retries remain."""
    validate_result = state.results.get("validate")
    if not validate_result or validate_result.status != Status.COMPLETED:
        return False
    # Check invocation_state via the result text
    result_text = str(validate_result.result) if validate_result.result else ""
    return "FAIL" in result_text and "PASS" not in result_text


def _is_passed(state: GraphState) -> bool:
    """Conditional edge: proceed to output when validation passes."""
    validate_result = state.results.get("validate")
    if not validate_result or validate_result.status != Status.COMPLETED:
        return False
    result_text = str(validate_result.result) if validate_result.result else ""
    return "PASS" in result_text


def create_planning_graph() -> object:
    """Build and return the Planning Orchestrator graph.

    Returns a callable Graph instance. Invoke with::

        graph = create_planning_graph()
        result = graph("task description", planning_input={...})

    or async::

        result = await graph.invoke_async("task", planning_input={...})
    """
    builder = GraphBuilder()

    # Create node instances
    parse_input = ParseInputNode()
    collect_context = CollectContextNode()
    generate_itinerary = GenerateItineraryNode()
    validate = ValidateNode()

    # Add nodes
    builder.add_node(parse_input, "parse_input")
    builder.add_node(collect_context, "collect_context")
    builder.add_node(generate_itinerary, "generate_itinerary")
    builder.add_node(validate, "validate")

    # Linear edges: parse -> collect -> generate -> validate
    builder.add_edge("parse_input", "collect_context")
    builder.add_edge("collect_context", "generate_itinerary")
    builder.add_edge("generate_itinerary", "validate")

    # Conditional retry loop: validate -> generate_itinerary (on failure)
    builder.add_edge("validate", "generate_itinerary", condition=_needs_retry)

    # Set entry point
    builder.set_entry_point("parse_input")

    # Safety limits
    builder.set_max_node_executions(10)  # Max total node executions (allows ~3 retries)
    builder.set_execution_timeout(300)   # 5-minute overall timeout

    # Reset node state when revisiting (retry loop)
    builder.reset_on_revisit(True)

    graph = builder.build()

    logger.info("Planning orchestrator graph built successfully")
    return graph
