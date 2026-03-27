"""Tool: get_trends -- Trend and TrendSpot lookup with time decay scoring."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from strands import tool

from src.tools.graph_client import execute_query, extract_node, parse_json_field

logger = logging.getLogger(__name__)


def _compute_effective_score(virality_score: int, decay_rate: float, date_str: str) -> float:
    """Compute effective_score = virality_score * (1 - decay_rate) ^ months_elapsed."""
    try:
        trend_date = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        # If date is unparseable, treat as recent
        return float(virality_score)

    now = datetime.now(timezone.utc)
    months_elapsed = max(0, (now.year - trend_date.year) * 12 + (now.month - trend_date.month))
    return virality_score * ((1 - decay_rate) ** months_elapsed)


def _infer_tier(decay_rate: float) -> str:
    """Infer trend tier from decay_rate. Used as fallback when tier is not stored."""
    if decay_rate <= 0.10:
        return "hot"
    if decay_rate <= 0.25:
        return "steady"
    return "seasonal"


@tool
def get_trends(region: str, min_score: int = 30) -> str:
    """Retrieve active trends and their associated TrendSpot locations for a region.

    Applies time-decay scoring and filters by effective score. Results
    are useful for injecting fresh, trending content into Layer 4-5 of
    an itinerary.

    Args:
        region: Region name to search for trends, e.g. '규슈', '간사이'.
        min_score: Minimum effective score after time decay (default 30).
    """
    rows = execute_query(
        "MATCH (t:Trend)-[rel:FILMED_AT|FEATURES]->(ts:TrendSpot)"
        "-[:LOCATED_IN]->(c:City {region: $region}) "
        "WHERE t.virality_score >= $min_score "
        "WITH t, collect(DISTINCT ts) AS spots "
        "RETURN t, spots",
        {"region": region, "min_score": min_score},
    )

    trends = []
    for item in rows:
        trend_data = extract_node(item, "t")
        for field in ("keywords",):
            if field in trend_data:
                trend_data[field] = parse_json_field(trend_data[field])

        virality = trend_data.get("virality_score", 0)
        decay = trend_data.get("decay_rate", 0.1)
        date_str = str(trend_data.get("date", ""))

        effective = _compute_effective_score(
            int(virality) if virality else 0,
            float(decay) if decay else 0.1,
            date_str,
        )

        if effective < min_score:
            continue

        spots_raw = item.get("spots", [])
        spots = [extract_node({"s": s}, "s") for s in spots_raw] if spots_raw else []

        tier = trend_data.get("tier") or _infer_tier(float(decay) if decay else 0.1)
        trends.append({
            "trend": {**trend_data, "tier": tier},
            "effective_score": round(effective, 1),
            "spots": spots,
        })

    # Sort by effective score descending
    trends.sort(key=lambda t: t["effective_score"], reverse=True)
    trends = trends[:10]

    return json.dumps({"trends": trends, "count": len(trends)}, ensure_ascii=False, default=str)
