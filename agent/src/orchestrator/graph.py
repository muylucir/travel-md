"""Planning Orchestrator -- Strands GraphBuilder DAG (2-Phase Architecture).

DAG topology::

    parse_input -> collect_context -> generate_skeleton -> validate_skeleton
    validate_skeleton -> generate_skeleton    (retry on failure)
    validate_skeleton -> generate_day_details (on pass)
    generate_day_details -> validate_day_details
    validate_day_details -> generate_day_details (retry failed days only)
    validate_day_details -> (end)                (on pass)
"""

from __future__ import annotations

import logging

from strands.multiagent.graph import GraphBuilder, GraphState
from strands.multiagent.base import Status

from src.orchestrator.nodes import (
    ParseInputNode,
    CollectContextNode,
    GenerateSkeletonNode,
    ValidateSkeletonNode,
    GenerateDayDetailsNode,
    ValidateDayDetailsNode,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Conditional edge functions
# ---------------------------------------------------------------------------

def _skeleton_needs_retry(state: GraphState) -> bool:
    """Route back to generate_skeleton if skeleton validation failed."""
    result = state.results.get("validate_skeleton")
    if not result or result.status != Status.COMPLETED:
        return False
    text = str(result.result) if result.result else ""
    return "SKELETON_FAIL" in text


def _skeleton_passed(state: GraphState) -> bool:
    """Proceed to day details when skeleton passes."""
    result = state.results.get("validate_skeleton")
    if not result or result.status != Status.COMPLETED:
        return False
    text = str(result.result) if result.result else ""
    return "SKELETON_PASS" in text


def _days_need_retry(state: GraphState) -> bool:
    """Route back to generate_day_details if day validation failed."""
    result = state.results.get("validate_day_details")
    if not result or result.status != Status.COMPLETED:
        return False
    text = str(result.result) if result.result else ""
    return "DAYS_FAIL" in text


def _days_passed(state: GraphState) -> bool:
    """Terminate when day validation passes."""
    result = state.results.get("validate_day_details")
    if not result or result.status != Status.COMPLETED:
        return False
    text = str(result.result) if result.result else ""
    return "DAYS_PASS" in text


# ---------------------------------------------------------------------------
# Graph factory
# ---------------------------------------------------------------------------

def create_planning_graph() -> object:
    """Build and return the 2-Phase Planning Orchestrator graph.

    Phase 1 (Skeleton): Sonnet generates travel structure (cities, flights, hotels)
    Phase 2 (Details):  Opus generates per-day attractions/meals/activities

    Returns a callable Graph instance.
    """
    builder = GraphBuilder()

    # Create node instances
    parse_input = ParseInputNode()
    collect_context = CollectContextNode()
    generate_skeleton = GenerateSkeletonNode()
    validate_skeleton = ValidateSkeletonNode()
    generate_day_details = GenerateDayDetailsNode()
    validate_day_details = ValidateDayDetailsNode()

    # Add nodes
    builder.add_node(parse_input, "parse_input")
    builder.add_node(collect_context, "collect_context")
    builder.add_node(generate_skeleton, "generate_skeleton")
    builder.add_node(validate_skeleton, "validate_skeleton")
    builder.add_node(generate_day_details, "generate_day_details")
    builder.add_node(validate_day_details, "validate_day_details")

    # Linear flow: parse -> collect -> skeleton -> validate_skeleton
    builder.add_edge("parse_input", "collect_context")
    builder.add_edge("collect_context", "generate_skeleton")
    builder.add_edge("generate_skeleton", "validate_skeleton")

    # Skeleton retry loop
    builder.add_edge("validate_skeleton", "generate_skeleton", condition=_skeleton_needs_retry)
    # Skeleton pass -> day details
    builder.add_edge("validate_skeleton", "generate_day_details", condition=_skeleton_passed)

    # Day details -> validation
    builder.add_edge("generate_day_details", "validate_day_details")
    # Day details retry loop (only failed days regenerated)
    builder.add_edge("validate_day_details", "generate_day_details", condition=_days_need_retry)

    # Entry point
    builder.set_entry_point("parse_input")

    # Safety limits (increased for 2-phase with two retry loops)
    builder.set_max_node_executions(20)
    builder.set_execution_timeout(600)  # 10 minutes

    # Reset node state on revisit (retry loops)
    builder.reset_on_revisit(True)

    graph = builder.build()
    logger.info("2-Phase Planning Orchestrator graph built successfully")
    return graph
