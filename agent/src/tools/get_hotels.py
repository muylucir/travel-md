"""Tool: get_hotels_by_city -- v3 city hotel lookup."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query, extract_node

logger = logging.getLogger(__name__)


@tool
def get_hotels_by_city(city: str, grade: str = "") -> str:
    """Retrieve hotels in a specific city.

    v3 edge direction: (Hotel)-[:IN_CITY]->(City). v3 Hotel has no
    onsen/amenity flags — only `grade` is filterable.

    Args:
        city: City name or code (e.g. '오사카', 'OSA').
        grade: Optional Hotel.grade filter.
    """
    where_parts = ["(c.name = $city OR c.code = $city)"]
    params: dict = {"city": city}
    if grade:
        where_parts.append("h.grade = $grade")
        params["grade"] = grade

    query = (
        "MATCH (h:Hotel)-[:IN_CITY]->(c:City) "
        "WHERE " + " AND ".join(where_parts) + " "
        "RETURN h LIMIT 200"
    )

    rows = execute_query(query, params)
    hotels = [extract_node(row, "h") for row in rows]

    return json.dumps(
        {"hotels": hotels, "count": len(hotels)}, ensure_ascii=False, default=str
    )
