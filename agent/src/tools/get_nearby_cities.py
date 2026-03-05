"""Tool: get_nearby_cities -- NEAR edge traversal for adjacent cities."""

from __future__ import annotations

import json
import logging

from gremlin_python.process.graph_traversal import __
from gremlin_python.process.traversal import P, Order

from strands import tool

from src.tools.graph_client import get_connection, map_to_dict

logger = logging.getLogger(__name__)


@tool
def get_nearby_cities(city: str, max_km: int = 100) -> str:
    """Find cities near the specified city within a maximum distance.

    Uses the NEAR edges in the Knowledge Graph to discover adjacent
    cities that could be added to an itinerary. Results are ordered
    by distance ascending.

    Args:
        city: The city name to search around, e.g. '다케오', '벳푸'.
        max_km: Maximum distance in kilometers (default 100).
    """
    g = get_connection()

    results = (
        g.V()
        .hasLabel("City")
        .has("name", city)
        .outE("NEAR")
        .has("distance_km", P.lte(max_km))
        .project("city", "distance_km")
        .by(__.inV().valueMap(True))
        .by(__.values("distance_km"))
        .order()
        .by(__.select("distance_km"), Order.asc)
        .toList()
    )

    cities = []
    for r in results:
        city_data = map_to_dict(r["city"])
        city_data["distance_km"] = r.get("distance_km", 0)
        cities.append(city_data)

    return json.dumps({"nearby_cities": cities, "count": len(cities)}, ensure_ascii=False, default=str)
