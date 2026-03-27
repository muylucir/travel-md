"""Tool: get_routes_by_region -- Available flight routes for a region."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query, extract_node

logger = logging.getLogger(__name__)


@tool
def get_routes_by_region(region: str) -> str:
    """Retrieve available flight routes that serve a given region.

    Routes are found by looking for Route nodes connected to cities in
    the specified region via TO edges.

    Args:
        region: The region name, e.g. '규슈', '간사이', '다낭'.
    """
    rows = execute_query(
        "MATCH (r:Route)-[:TO]->(c:City {region: $region}) RETURN r",
        {"region": region},
    )
    routes = [extract_node(row, "r") for row in rows]

    return json.dumps({"routes": routes, "count": len(routes)}, ensure_ascii=False, default=str)
