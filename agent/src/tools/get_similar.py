"""Tool: get_similar_packages -- v3 sibling SaleProducts."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query, extract_node

logger = logging.getLogger(__name__)


@tool
def get_similar_packages(saleProdCd: str) -> str:
    """Find SaleProducts similar to the given one.

    v3 has no SIMILAR_TO edge; this returns sibling products under the
    same RepresentativeProduct (INSTANCE_OF), and falls back to the same
    arrival city when no siblings exist.

    Args:
        saleProdCd: The reference SaleProduct code.
    """
    if not saleProdCd:
        return json.dumps({"error": "saleProdCd is required"}, ensure_ascii=False)

    rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code})-[:INSTANCE_OF]->(rp:RepresentativeProduct) "
        "MATCH (p2:SaleProduct)-[:INSTANCE_OF]->(rp) "
        "WHERE p2.saleProdCd <> $code "
        "RETURN p2 LIMIT 10",
        {"code": saleProdCd},
    )

    if not rows:
        rows = execute_query(
            "MATCH (p:SaleProduct {saleProdCd: $code}) "
            "MATCH (p2:SaleProduct) "
            "WHERE p2.saleProdCd <> $code AND p2.arrCityCd = p.arrCityCd "
            "RETURN p2 LIMIT 10",
            {"code": saleProdCd},
        )

    similar = [{"saleProduct": extract_node(r, "p2")} for r in rows]
    return json.dumps(
        {"similar_packages": similar, "count": len(similar)},
        ensure_ascii=False,
        default=str,
    )
