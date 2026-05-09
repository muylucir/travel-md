"""Strands @tool wrappers for the score-first Graph RAG redesign."""

from src.tools.skeleton_tools import (
    get_reference_package,
    find_similar_packages,
    recommend_route,
)
from src.tools.day_detail_tools import (
    recommend_attractions,
    recommend_hotels,
    get_attraction_neighbors,
    get_attraction_detail,
)

# Tools used by Skeleton-phase Sonnet agent
SKELETON_TOOLS = [
    get_reference_package,
    find_similar_packages,
    recommend_route,
]

# Tools used by Day-Detail Opus agent
DAY_DETAIL_TOOLS = [
    recommend_attractions,
    recommend_hotels,
    get_attraction_neighbors,
    get_attraction_detail,
]

# Convenience: every tool exposed to LLM agents
ALL_TOOLS = SKELETON_TOOLS + DAY_DETAIL_TOOLS

__all__ = [
    "get_reference_package",
    "find_similar_packages",
    "recommend_route",
    "recommend_attractions",
    "recommend_hotels",
    "get_attraction_neighbors",
    "get_attraction_detail",
    "SKELETON_TOOLS",
    "DAY_DETAIL_TOOLS",
    "ALL_TOOLS",
]
