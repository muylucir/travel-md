"""Tool: get_nearby_cities -- v3 city distance lookup (no NEAR edge)."""

from __future__ import annotations

import json
import logging
import math

from strands import tool

from src.tools.graph_client import execute_query

logger = logging.getLogger(__name__)


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


@tool
def get_nearby_cities(city: str, max_km: int = 100) -> str:
    """Find cities within max_km of the given city.

    v3 has no NEAR edge — distance is computed in-process from
    City.centerLat/centerLng. Limited to cities sharing the same country.

    Args:
        city: City name or code (e.g. '오사카', 'OSA').
        max_km: Maximum distance in kilometers (default 100).
    """
    src_rows = execute_query(
        "MATCH (c:City) WHERE c.name = $city OR c.code = $city "
        "RETURN c.code AS code, c.name AS name, c.countryCode AS country, "
        "       c.centerLat AS lat, c.centerLng AS lng LIMIT 1",
        {"city": city},
    )
    if not src_rows:
        return json.dumps(
            {"nearby_cities": [], "count": 0, "error": f"City '{city}' not found"},
            ensure_ascii=False,
        )

    src = src_rows[0]
    src_lat, src_lng = src.get("lat"), src.get("lng")
    if src_lat is None or src_lng is None:
        return json.dumps(
            {"nearby_cities": [], "count": 0, "error": f"City '{city}' has no coordinates"},
            ensure_ascii=False,
        )

    cand_rows = execute_query(
        "MATCH (c:City) "
        "WHERE c.countryCode = $country AND c.code <> $code "
        "  AND c.centerLat IS NOT NULL AND c.centerLng IS NOT NULL "
        "RETURN c.code AS code, c.name AS name, c.countryCode AS countryCode, "
        "       c.centerLat AS lat, c.centerLng AS lng",
        {"country": src.get("country"), "code": src.get("code")},
    )

    nearby = []
    for r in cand_rows:
        try:
            d = _haversine_km(
                float(src_lat), float(src_lng), float(r["lat"]), float(r["lng"])
            )
        except (TypeError, ValueError):
            continue
        if d <= max_km:
            nearby.append(
                {
                    "code": r.get("code"),
                    "name": r.get("name"),
                    "countryCode": r.get("countryCode"),
                    "distance_km": round(d, 1),
                }
            )
    nearby.sort(key=lambda x: x["distance_km"])

    return json.dumps(
        {"nearby_cities": nearby, "count": len(nearby)}, ensure_ascii=False, default=str
    )
