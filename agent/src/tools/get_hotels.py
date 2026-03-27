"""Tool: get_hotels_by_city -- City hotel lookup."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query, extract_node

logger = logging.getLogger(__name__)


@tool
def get_hotels_by_city(city: str, grade: str = "", has_onsen: bool = False) -> str:
    """Retrieve hotels in a specific city, optionally filtered by grade and onsen availability.

    Use this to find alternative hotel options when building an itinerary.

    Args:
        city: City name, e.g. '이마리', '오사카'.
        grade: Optional hotel grade filter, e.g. '비즈니스', '5성급', '료칸'.
        has_onsen: If true, only return hotels with onsen facilities.
    """
    where_parts = []
    params: dict = {"city": city}

    if grade:
        where_parts.append("h.grade = $grade")
        params["grade"] = grade
    if has_onsen:
        where_parts.append("h.has_onsen = true")

    query = "MATCH (:City {name: $city})-[:HAS_HOTEL]->(h:Hotel)"
    if where_parts:
        query += " WHERE " + " AND ".join(where_parts)
    query += " RETURN h"

    rows = execute_query(query, params)
    hotels = [extract_node(row, "h") for row in rows]

    return json.dumps({"hotels": hotels, "count": len(hotels)}, ensure_ascii=False, default=str)
