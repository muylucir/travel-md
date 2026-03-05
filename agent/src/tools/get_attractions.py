"""Tool: get_attractions_by_city -- City attractions lookup."""

from __future__ import annotations

import json
import logging

from gremlin_python.process.graph_traversal import __

from strands import tool

from src.tools.graph_client import get_connection, map_to_dict

logger = logging.getLogger(__name__)


@tool
def get_attractions_by_city(city: str, category: str = "") -> str:
    """Retrieve attractions located in a specific city, optionally filtered by category.

    Use this to find alternative or additional attractions when building
    or modifying an itinerary.

    Args:
        city: City name, e.g. '다케오', '오사카'.
        category: Optional attraction category, e.g. '신사', '자연', '문화'.
    """
    g = get_connection()

    t = (
        g.V()
        .hasLabel("City")
        .has("name", city)
        .out("HAS_ATTRACTION")
        .hasLabel("Attraction")
    )

    if category:
        t = t.has("category", category)

    results = t.valueMap(True).toList()
    attractions = [map_to_dict(a) for a in results]

    return json.dumps({"attractions": attractions, "count": len(attractions)}, ensure_ascii=False, default=str)
