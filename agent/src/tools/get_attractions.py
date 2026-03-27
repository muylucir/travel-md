"""Tool: get_attractions_by_city -- City attractions lookup."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query, extract_node

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
    if category:
        query = "MATCH (:City {name: $city})-[:HAS_ATTRACTION]->(a:Attraction {category: $category}) RETURN a"
        params = {"city": city, "category": category}
    else:
        query = "MATCH (:City {name: $city})-[:HAS_ATTRACTION]->(a:Attraction) RETURN a"
        params = {"city": city}

    rows = execute_query(query, params)
    attractions = [extract_node(row, "a") for row in rows]

    return json.dumps({"attractions": attractions, "count": len(attractions)}, ensure_ascii=False, default=str)
