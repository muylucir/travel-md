"""Tool: get_similar_packages -- SIMILAR_TO edge traversal."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query, extract_node, parse_json_field

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
    rows = execute_query(
        "MATCH (:Package {code: $code})-[s:SIMILAR_TO]->(p2:Package) "
        "RETURN p2, s.score AS score "
        "ORDER BY s.score DESC LIMIT 10",
        {"code": package_code},
    )

    packages = []
    for row in rows:
        pkg = extract_node(row, "p2")
        for field in ("season", "hashtags", "guide_fee"):
            if field in pkg:
                pkg[field] = parse_json_field(pkg[field])
        packages.append({
            "package": pkg,
            "similarity_score": row.get("score", 0),
        })

    return json.dumps({"similar_packages": packages, "count": len(packages)}, ensure_ascii=False, default=str)
