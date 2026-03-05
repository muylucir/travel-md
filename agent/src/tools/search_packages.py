"""Tool: search_packages -- Multi-condition package search via Gremlin."""

from __future__ import annotations

import json
import logging

from gremlin_python.process.graph_traversal import __
from gremlin_python.process.traversal import P, TextP, Order

from strands import tool

from src.tools.graph_client import get_connection, map_to_dict, parse_json_field

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
    g = get_connection()

    # Start from packages that visit the destination (city or region)
    t = (
        g.V()
        .hasLabel("Package")
        .where(
            __.out("VISITS")
            .hasLabel("City")
            .or_(
                __.has("name", destination),
                __.has("region", destination),
            )
        )
    )

    # Theme filter
    if theme:
        t = t.where(__.out("TAGGED").has("name", theme))

    # Season filter -- season is stored as JSON array string or multi-value property
    if season:
        t = t.has("season", TextP.containing(season))

    # Nights filter
    if nights and nights > 0:
        t = t.has("nights", nights)

    # Budget filter
    if max_budget and max_budget > 0:
        t = t.has("price", P.lte(max_budget))

    # Shopping count filter
    if shopping_max >= 0:
        t = t.has("shopping_count", P.lte(shopping_max))

    # Order and limit
    results = t.order().by("rating", Order.desc).limit(10).valueMap(True).toList()

    packages = []
    for r in results:
        pkg = map_to_dict(r)
        for field in ("season", "hashtags", "guide_fee"):
            if field in pkg:
                pkg[field] = parse_json_field(pkg[field])
        packages.append(pkg)

    return json.dumps({"packages": packages, "count": len(packages)}, ensure_ascii=False, default=str)
