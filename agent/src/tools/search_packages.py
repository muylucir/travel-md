"""Tool: search_packages -- v3 SaleProduct multi-condition search."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query, extract_node

logger = logging.getLogger(__name__)


@tool
def search_packages(
    destination: str,
    nights: int = 0,
    theme_key: str = "",
    season_quarter: int = 0,
) -> str:
    """Search SaleProducts. Matches by arrival city or visited city.
    theme_key/season_quarter filter through scheduled attractions'
    IN_THEME / BEST_IN_SEASON weights (>0).

    Args:
        destination: City name or code (e.g. '오사카', 'OSA').
        nights: Optional trvlNgtCnt match (0 = no filter).
        theme_key: Optional Theme.key (e.g. 'FAMILY_WITH_KIDS', 'HEALING').
        season_quarter: Optional Season.quarter 1..4 (0 = no filter).
    """
    where_parts = [
        "(c.name = $dest OR c.code = $dest OR p.arrCityNm = $dest OR p.arrCityCd = $dest)"
    ]
    params: dict = {"dest": destination}

    match_lines = [
        "MATCH (p:SaleProduct)",
        "OPTIONAL MATCH (p)-[:VISITS_CITY]->(c:City)",
    ]

    if nights and nights > 0:
        where_parts.append("p.trvlNgtCnt = $nights")
        params["nights"] = nights

    if theme_key:
        match_lines.append(
            "MATCH (p)-[:HAS_SCHEDULED_ATTRACTION]->(:Attraction)-[it:IN_THEME]->(:Theme {key: $theme_key})"
        )
        where_parts.append("it.weight > 0")
        params["theme_key"] = theme_key

    if season_quarter and 1 <= season_quarter <= 4:
        match_lines.append(
            "MATCH (p)-[:HAS_SCHEDULED_ATTRACTION]->(:Attraction)-[bs:BEST_IN_SEASON]->(:Season {quarter: $q})"
        )
        where_parts.append("bs.weight > 0")
        params["q"] = season_quarter

    query = "\n".join(match_lines)
    query += "\nWHERE " + " AND ".join(where_parts)
    query += "\nRETURN DISTINCT p LIMIT 20"

    rows = execute_query(query, params)
    packages = [extract_node(row, "p") for row in rows]
    return json.dumps(
        {"packages": packages, "count": len(packages)}, ensure_ascii=False, default=str
    )
