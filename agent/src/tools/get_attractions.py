"""Tool: get_attractions_by_city -- v3 city attractions lookup."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query, extract_node

logger = logging.getLogger(__name__)


@tool
def get_attractions_by_city(city: str, attraction_type: str = "") -> str:
    """Retrieve attractions in a specific city.

    v3 edge direction: (Attraction)-[:IN_CITY]->(City).

    Args:
        city: City name or code (e.g. '오사카', 'OSA').
        attraction_type: Optional Attraction.type filter (e.g. 'NATURE', 'CULTURE').
    """
    if attraction_type:
        query = (
            "MATCH (a:Attraction)-[:IN_CITY]->(c:City) "
            "WHERE (c.name = $city OR c.code = $city) AND a.type = $t "
            "RETURN a LIMIT 200"
        )
        params = {"city": city, "t": attraction_type}
    else:
        query = (
            "MATCH (a:Attraction)-[:IN_CITY]->(c:City) "
            "WHERE c.name = $city OR c.code = $city "
            "RETURN a LIMIT 200"
        )
        params = {"city": city}

    rows = execute_query(query, params)
    attractions = [extract_node(row, "a") for row in rows]

    return json.dumps(
        {"attractions": attractions, "count": len(attractions)},
        ensure_ascii=False,
        default=str,
    )
