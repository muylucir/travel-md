"""Tool: get_routes_by_region -- Available flight routes for a region."""

from __future__ import annotations

import json
import logging

from gremlin_python.process.graph_traversal import __

from strands import tool

from src.tools.graph_client import get_connection, map_to_dict

logger = logging.getLogger(__name__)


@tool
def get_routes_by_region(region: str) -> str:
    """Retrieve available flight routes that serve a given region.

    Routes are found by looking for Route nodes connected to cities in
    the specified region via FROM/TO edges.

    Args:
        region: The region name, e.g. '규슈', '간사이', '다낭'.
    """
    g = get_connection()

    # Find routes whose destination city is in the given region
    results = (
        g.V()
        .hasLabel("Route")
        .where(
            __.out("TO")
            .hasLabel("City")
            .has("region", region)
        )
        .valueMap(True)
        .toList()
    )

    routes = [map_to_dict(r) for r in results]

    return json.dumps({"routes": routes, "count": len(routes)}, ensure_ascii=False, default=str)
