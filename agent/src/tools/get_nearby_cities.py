"""Tool: get_nearby_cities -- NEAR edge traversal for adjacent cities."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query, extract_node

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
    rows = execute_query(
        "MATCH (:City {name: $city})-[n:NEAR]->(c2:City) "
        "WHERE n.distance_km <= $max_km "
        "RETURN c2, n.distance_km AS distance_km "
        "ORDER BY n.distance_km ASC",
        {"city": city, "max_km": max_km},
    )

    cities = []
    for row in rows:
        city_data = extract_node(row, "c2")
        city_data["distance_km"] = row.get("distance_km", 0)
        cities.append(city_data)

    return json.dumps({"nearby_cities": cities, "count": len(cities)}, ensure_ascii=False, default=str)
