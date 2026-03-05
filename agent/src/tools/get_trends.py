"""Tool: get_trends -- Trend and TrendSpot lookup with time decay scoring."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from gremlin_python.process.graph_traversal import __
from gremlin_python.process.traversal import P, Order

from strands import tool

from src.tools.graph_client import get_connection, map_to_dict, parse_json_field

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
    g = get_connection()

    # Fetch Trend nodes connected to TrendSpots in the target region
    raw = (
        g.V()
        .hasLabel("Trend")
        .has("virality_score", P.gte(min_score))
        .where(
            __.out("FILMED_AT", "FEATURES")
            .out("LOCATED_IN")
            .hasLabel("City")
            .has("region", region)
        )
        .project("trend", "spots")
        .by(__.valueMap(True))
        .by(
            __.out("FILMED_AT", "FEATURES")
            .where(
                __.out("LOCATED_IN")
                .hasLabel("City")
                .has("region", region)
            )
            .valueMap(True)
            .fold()
        )
        .toList()
    )

    trends = []
    for item in raw:
        trend_data = map_to_dict(item["trend"])
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

        spots = [map_to_dict(s) for s in item.get("spots", [])]

        trends.append({
            "trend": trend_data,
            "effective_score": round(effective, 1),
            "spots": spots,
        })

    # Sort by effective score descending
    trends.sort(key=lambda t: t["effective_score"], reverse=True)
    trends = trends[:10]

    return json.dumps({"trends": trends, "count": len(trends)}, ensure_ascii=False, default=str)
