"""Tool: get_package -- Retrieve full package information and related entities."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query, extract_node, parse_json_field

logger = logging.getLogger(__name__)


@tool
def get_package(package_code: str) -> str:
    """Retrieve complete package information including related cities, attractions, hotels, routes, themes, and activities.

    Use this tool when you need to inspect a specific existing package to use as a
    reference for generating a new itinerary.

    Args:
        package_code: The unique package code, e.g. 'JKP130260401TWX'.
    """
    params = {"code": package_code}

    # --- Package node ---
    pkg_rows = execute_query(
        "MATCH (p:Package {code: $code}) RETURN p",
        params,
    )
    if not pkg_rows:
        return json.dumps({"error": f"Package '{package_code}' not found"}, ensure_ascii=False)

    package = extract_node(pkg_rows[0], "p")
    for field in ("season", "hashtags", "guide_fee"):
        if field in package:
            package[field] = parse_json_field(package[field])

    # --- Visited cities ---
    city_rows = execute_query(
        "MATCH (p:Package {code: $code})-[v:VISITS]->(c:City) "
        "RETURN c, v.day AS day, v.`order` AS order",
        params,
    )
    city_list = []
    for row in city_rows:
        city_data = extract_node(row, "c")
        city_data["day"] = row.get("day")
        city_data["order"] = row.get("order")
        city_list.append(city_data)

    # --- Included attractions ---
    attr_rows = execute_query(
        "MATCH (p:Package {code: $code})-[i:INCLUDES]->(a:Attraction) "
        "RETURN a, i.day AS day, i.`order` AS order, i.layer AS layer",
        params,
    )
    attraction_list = []
    for row in attr_rows:
        attr_data = extract_node(row, "a")
        attr_data["day"] = row.get("day")
        attr_data["order"] = row.get("order")
        attr_data["layer"] = row.get("layer")
        attraction_list.append(attr_data)

    # --- Hotels ---
    hotel_rows = execute_query(
        "MATCH (p:Package {code: $code})-[:INCLUDES_HOTEL]->(h:Hotel) RETURN h",
        params,
    )
    hotel_list = [extract_node(row, "h") for row in hotel_rows]

    # --- Routes (flights) ---
    route_rows = execute_query(
        "MATCH (p:Package {code: $code})-[d:DEPARTS_ON]->(r:Route) "
        "RETURN r, d.type AS flight_type",
        params,
    )
    route_list = []
    for row in route_rows:
        route_data = extract_node(row, "r")
        route_data["flight_type"] = row.get("flight_type")
        route_list.append(route_data)

    # --- Themes ---
    theme_rows = execute_query(
        "MATCH (p:Package {code: $code})-[:TAGGED]->(t:Theme) RETURN t",
        params,
    )
    theme_list = [extract_node(row, "t") for row in theme_rows]

    # --- Activities ---
    act_rows = execute_query(
        "MATCH (p:Package {code: $code})-[ha:HAS_ACTIVITY]->(a) "
        "RETURN a, ha.day AS day",
        params,
    )
    activity_list = []
    for row in act_rows:
        act_data = extract_node(row, "a")
        act_data["day"] = row.get("day")
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
