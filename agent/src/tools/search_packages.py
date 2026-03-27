"""Tool: search_packages -- Multi-condition package search via OpenCypher."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query, extract_node, parse_json_field

logger = logging.getLogger(__name__)


@tool
def search_packages(
    destination: str,
    theme: str = "",
    season: str = "",
    nights: int = 0,
    max_budget: int = 0,
    shopping_max: int = -1,
) -> str:
    """Search for existing travel packages matching the given conditions.

    Use this tool to find reference packages or similar packages for a
    destination. All filter parameters except destination are optional.

    Args:
        destination: Region or city name to search, e.g. '규슈', '오사카'.
        theme: Optional theme filter, e.g. '가족여행', '힐링'.
        season: Optional season filter, e.g. '봄', '여름'.
        nights: Optional number of nights (0 means no filter).
        max_budget: Optional maximum price per person in KRW (0 means no filter).
        shopping_max: Optional maximum shopping count (-1 means no filter).
    """
    match_parts = ["MATCH (p:Package)-[:VISITS]->(c:City)"]
    where_parts = ["(c.name = $dest OR c.region = $dest)"]
    params: dict = {"dest": destination}

    if theme:
        match_parts.append("MATCH (p)-[:TAGGED]->(th:Theme {name: $theme})")
        params["theme"] = theme
    if season:
        where_parts.append("p.season CONTAINS $season")
        params["season"] = season
    if nights and nights > 0:
        where_parts.append("p.nights = $nights")
        params["nights"] = nights
    if max_budget and max_budget > 0:
        where_parts.append("p.price <= $max_budget")
        params["max_budget"] = max_budget
    if shopping_max >= 0:
        where_parts.append("p.shopping_count <= $shopping_max")
        params["shopping_max"] = shopping_max

    query = "\n".join(match_parts)
    query += "\nWHERE " + " AND ".join(where_parts)
    query += "\nRETURN DISTINCT p ORDER BY p.rating DESC LIMIT 10"

    rows = execute_query(query, params)
    packages = []
    for row in rows:
        pkg = extract_node(row, "p")
        for field in ("season", "hashtags", "guide_fee"):
            if field in pkg:
                pkg[field] = parse_json_field(pkg[field])
        packages.append(pkg)

    return json.dumps({"packages": packages, "count": len(packages)}, ensure_ascii=False, default=str)
