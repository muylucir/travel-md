"""Tool: get_similar_packages -- SIMILAR_TO edge traversal."""

from __future__ import annotations

import json
import logging

from gremlin_python.process.graph_traversal import __
from gremlin_python.process.traversal import Order

from strands import tool

from src.tools.graph_client import get_connection, map_to_dict, parse_json_field

logger = logging.getLogger(__name__)


@tool
def get_similar_packages(package_code: str) -> str:
    """Find packages that are similar to the given package via SIMILAR_TO edges.

    Returns a list of similar packages ordered by similarity score descending.
    Useful for finding alternative reference packages or understanding the
    competitive landscape.

    Args:
        package_code: The package code to find similar packages for, e.g. 'JKP130260401TWX'.
    """
    g = get_connection()

    results = (
        g.V()
        .hasLabel("Package")
        .has("code", package_code)
        .outE("SIMILAR_TO")
        .project("package", "score")
        .by(__.inV().valueMap(True))
        .by(__.values("score"))
        .order()
        .by(__.select("score"), Order.desc)
        .limit(10)
        .toList()
    )

    packages = []
    for r in results:
        pkg = map_to_dict(r["package"])
        for field in ("season", "hashtags", "guide_fee"):
            if field in pkg:
                pkg[field] = parse_json_field(pkg[field])
        packages.append({
            "package": pkg,
            "similarity_score": r.get("score", 0),
        })

    return json.dumps({"similar_packages": packages, "count": len(packages)}, ensure_ascii=False, default=str)
