"""Tool: get_hotels_by_city -- City hotel lookup."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import get_connection, map_to_dict

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
    g = get_connection()

    t = (
        g.V()
        .hasLabel("City")
        .has("name", city)
        .out("HAS_HOTEL")
        .hasLabel("Hotel")
    )

    if grade:
        t = t.has("grade", grade)

    if has_onsen:
        t = t.has("has_onsen", True)

    results = t.valueMap(True).toList()
    hotels = [map_to_dict(h) for h in results]

    return json.dumps({"hotels": hotels, "count": len(hotels)}, ensure_ascii=False, default=str)
