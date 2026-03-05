"""Tool: get_package -- Retrieve full package information and related entities."""

from __future__ import annotations

import json
import logging

from gremlin_python.process.graph_traversal import __
from gremlin_python.process.traversal import T

from strands import tool

from src.tools.graph_client import get_connection, map_to_dict, parse_json_field

logger = logging.getLogger(__name__)


@tool
def get_package(package_code: str) -> str:
    """Retrieve complete package information including related cities, attractions, hotels, routes, themes, and activities.

    Use this tool when you need to inspect a specific existing package to use as a
    reference for generating a new itinerary.

    Args:
        package_code: The unique package code, e.g. 'JKP130260401TWX'.
    """
    g = get_connection()

    # --- Package node ---
    pkg_maps = (
        g.V()
        .hasLabel("Package")
        .has("code", package_code)
        .valueMap(True)
        .toList()
    )
    if not pkg_maps:
        return json.dumps({"error": f"Package '{package_code}' not found"}, ensure_ascii=False)

    package = map_to_dict(pkg_maps[0])
    # Parse JSON-encoded fields
    for field in ("season", "hashtags", "guide_fee"):
        if field in package:
            package[field] = parse_json_field(package[field])

    # --- Visited cities ---
    cities = (
        g.V()
        .hasLabel("Package")
        .has("code", package_code)
        .outE("VISITS")
        .project("city", "day", "order")
        .by(__.inV().valueMap(True))
        .by(__.values("day").fold())
        .by(__.values("order").fold())
        .toList()
    )
    city_list = []
    for c in cities:
        city_data = map_to_dict(c["city"])
        day_vals = c.get("day", [])
        order_vals = c.get("order", [])
        city_data["day"] = day_vals[0] if day_vals else None
        city_data["order"] = order_vals[0] if order_vals else None
        city_list.append(city_data)

    # --- Included attractions ---
    attractions = (
        g.V()
        .hasLabel("Package")
        .has("code", package_code)
        .outE("INCLUDES")
        .project("attraction", "day", "order", "layer")
        .by(__.inV().valueMap(True))
        .by(__.values("day").fold())
        .by(__.values("order").fold())
        .by(__.values("layer").fold())
        .toList()
    )
    attraction_list = []
    for a in attractions:
        attr_data = map_to_dict(a["attraction"])
        attr_data["day"] = (a.get("day") or [None])[0]
        attr_data["order"] = (a.get("order") or [None])[0]
        attr_data["layer"] = (a.get("layer") or [None])[0]
        attraction_list.append(attr_data)

    # --- Hotels ---
    hotels = (
        g.V()
        .hasLabel("Package")
        .has("code", package_code)
        .out("INCLUDES_HOTEL")
        .valueMap(True)
        .toList()
    )
    hotel_list = [map_to_dict(h) for h in hotels]

    # --- Routes (flights) ---
    routes = (
        g.V()
        .hasLabel("Package")
        .has("code", package_code)
        .outE("DEPARTS_ON")
        .project("route", "type")
        .by(__.inV().valueMap(True))
        .by(__.values("type").fold())
        .toList()
    )
    route_list = []
    for r in routes:
        route_data = map_to_dict(r["route"])
        route_data["flight_type"] = (r.get("type") or [None])[0]
        route_list.append(route_data)

    # --- Themes ---
    themes = (
        g.V()
        .hasLabel("Package")
        .has("code", package_code)
        .out("TAGGED")
        .valueMap(True)
        .toList()
    )
    theme_list = [map_to_dict(t) for t in themes]

    # --- Activities ---
    activities = (
        g.V()
        .hasLabel("Package")
        .has("code", package_code)
        .outE("HAS_ACTIVITY")
        .project("activity", "day")
        .by(__.inV().valueMap(True))
        .by(__.values("day").fold())
        .toList()
    )
    activity_list = []
    for act in activities:
        act_data = map_to_dict(act["activity"])
        act_data["day"] = (act.get("day") or [None])[0]
        activity_list.append(act_data)

    result = {
        "package": package,
        "cities": city_list,
        "attractions": attraction_list,
        "hotels": hotel_list,
        "routes": route_list,
        "themes": theme_list,
        "activities": activity_list,
    }

    return json.dumps(result, ensure_ascii=False, default=str)
