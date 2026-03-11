"""Graph RAG tools + cache invalidation for Lambda.

Reuses the Gremlin query logic from the agent tools but returns raw
JSON strings suitable for the Lambda handler response.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

from gremlin_python.process.graph_traversal import __
from gremlin_python.process.traversal import P, TextP, Order

from graph_client import get_connection, map_to_dict, parse_json_field

logger = logging.getLogger(__name__)


# -------------------------------------------------------------------------
# 1. get_package
# -------------------------------------------------------------------------
def get_package(package_code: str) -> str:
    """Retrieve complete package information including related entities."""
    g = get_connection()

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
    for field in ("season", "hashtags", "guide_fee"):
        if field in package:
            package[field] = parse_json_field(package[field])

    cities = (
        g.V().hasLabel("Package").has("code", package_code)
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
        city_data["day"] = (c.get("day") or [None])[0]
        city_data["order"] = (c.get("order") or [None])[0]
        city_list.append(city_data)

    attractions = (
        g.V().hasLabel("Package").has("code", package_code)
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

    hotels = (
        g.V().hasLabel("Package").has("code", package_code)
        .out("INCLUDES_HOTEL").valueMap(True).toList()
    )
    hotel_list = [map_to_dict(h) for h in hotels]

    routes = (
        g.V().hasLabel("Package").has("code", package_code)
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

    themes = (
        g.V().hasLabel("Package").has("code", package_code)
        .out("TAGGED").valueMap(True).toList()
    )
    theme_list = [map_to_dict(t) for t in themes]

    activities = (
        g.V().hasLabel("Package").has("code", package_code)
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


# -------------------------------------------------------------------------
# 2. search_packages
# -------------------------------------------------------------------------
def search_packages(
    destination: str,
    theme: str = "",
    season: str = "",
    nights: int = 0,
    max_budget: int = 0,
    shopping_max: int = -1,
) -> str:
    """Search for existing travel packages matching conditions."""
    g = get_connection()

    t = (
        g.V().hasLabel("Package")
        .where(
            __.out("VISITS").hasLabel("City")
            .or_(__.has("name", destination), __.has("region", destination))
        )
    )

    if theme:
        t = t.where(__.out("TAGGED").has("name", theme))
    if season:
        t = t.has("season", TextP.containing(season))
    if nights and nights > 0:
        t = t.has("nights", nights)
    if max_budget and max_budget > 0:
        t = t.has("price", P.lte(max_budget))
    if shopping_max >= 0:
        t = t.has("shopping_count", P.lte(shopping_max))

    results = t.order().by("rating", Order.desc).limit(10).valueMap(True).toList()

    packages = []
    for r in results:
        pkg = map_to_dict(r)
        for field in ("season", "hashtags", "guide_fee"):
            if field in pkg:
                pkg[field] = parse_json_field(pkg[field])
        packages.append(pkg)

    return json.dumps({"packages": packages, "count": len(packages)}, ensure_ascii=False, default=str)


# -------------------------------------------------------------------------
# 3. get_routes_by_region
# -------------------------------------------------------------------------
def get_routes_by_region(region: str) -> str:
    """Retrieve available flight routes for a region."""
    g = get_connection()

    results = (
        g.V().hasLabel("Route")
        .where(__.out("TO").hasLabel("City").has("region", region))
        .valueMap(True).toList()
    )
    routes = [map_to_dict(r) for r in results]
    return json.dumps({"routes": routes, "count": len(routes)}, ensure_ascii=False, default=str)


# -------------------------------------------------------------------------
# 4. get_attractions_by_city
# -------------------------------------------------------------------------
def get_attractions_by_city(city: str, category: str = "") -> str:
    """Retrieve attractions in a city, optionally filtered by category."""
    g = get_connection()

    t = (
        g.V().hasLabel("City").has("name", city)
        .out("HAS_ATTRACTION").hasLabel("Attraction")
    )
    if category:
        t = t.has("category", category)

    results = t.valueMap(True).toList()
    attractions = [map_to_dict(a) for a in results]
    return json.dumps({"attractions": attractions, "count": len(attractions)}, ensure_ascii=False, default=str)


# -------------------------------------------------------------------------
# 5. get_hotels_by_city
# -------------------------------------------------------------------------
def get_hotels_by_city(city: str, grade: str = "", has_onsen: bool = False) -> str:
    """Retrieve hotels in a city, optionally filtered by grade and onsen."""
    g = get_connection()

    t = (
        g.V().hasLabel("City").has("name", city)
        .out("HAS_HOTEL").hasLabel("Hotel")
    )
    if grade:
        t = t.has("grade", grade)
    if has_onsen:
        t = t.has("has_onsen", True)

    results = t.valueMap(True).toList()
    hotels = [map_to_dict(h) for h in results]
    return json.dumps({"hotels": hotels, "count": len(hotels)}, ensure_ascii=False, default=str)


# -------------------------------------------------------------------------
# 6. get_trends
# -------------------------------------------------------------------------
def _compute_effective_score(virality_score: int, decay_rate: float, date_str: str) -> float:
    """Compute effective_score = virality_score * (1 - decay_rate) ^ months_elapsed."""
    try:
        trend_date = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
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


def get_trends(region: str = "", country: str = "", city: str = "", min_score: int = 30) -> str:
    """Retrieve active trends and TrendSpot locations for a region, country, or city."""
    g = get_connection()

    # Build location filter
    if city:
        location_filter = __.out("LOCATED_IN").hasLabel("City").has("name", city)
    elif region:
        location_filter = __.out("LOCATED_IN").hasLabel("City").has("region", region)
    elif country:
        location_filter = __.out("LOCATED_IN").hasLabel("City").has("country", country)
    else:
        location_filter = __.out("LOCATED_IN").hasLabel("City")

    raw = (
        g.V().hasLabel("Trend")
        .has("virality_score", P.gte(min_score))
        .where(
            __.out("FILMED_AT", "FEATURES").where(location_filter)
        )
        .project("trend", "spots")
        .by(__.valueMap(True))
        .by(
            __.out("FILMED_AT", "FEATURES")
            .where(location_filter)
            .valueMap(True).fold()
        )
        .toList()
    )

    trends = []
    for item in raw:
        trend_data = map_to_dict(item["trend"])
        for field in ("keywords", "evidence"):
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
        tier = trend_data.get("tier") or _infer_tier(float(decay) if decay else 0.1)
        trends.append({
            "trend": {**trend_data, "tier": tier},
            "effective_score": round(effective, 1),
            "spots": spots,
        })

    trends.sort(key=lambda t: t["effective_score"], reverse=True)
    trends = trends[:10]

    return json.dumps({"trends": trends, "count": len(trends)}, ensure_ascii=False, default=str)


# -------------------------------------------------------------------------
# 7. get_similar_packages
# -------------------------------------------------------------------------
def get_similar_packages(package_code: str) -> str:
    """Find packages similar to the given package via SIMILAR_TO edges."""
    g = get_connection()

    results = (
        g.V().hasLabel("Package").has("code", package_code)
        .outE("SIMILAR_TO")
        .project("package", "score")
        .by(__.inV().valueMap(True))
        .by(__.values("score"))
        .order().by(__.select("score"), Order.desc)
        .limit(10).toList()
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


# -------------------------------------------------------------------------
# 8. get_nearby_cities
# -------------------------------------------------------------------------
# -------------------------------------------------------------------------
# 9. upsert_trend
# -------------------------------------------------------------------------
def upsert_trend(
    title: str,
    type: str,
    source: str,
    date: str,
    virality_score: int,
    decay_rate: float,
    tier: str = "",
    keywords: list[str] | None = None,
    evidence: list[dict] | None = None,
) -> str:
    """Upsert a Trend vertex in Neptune. Creates if not exists, updates if exists.

    Args:
        evidence: List of evidence items, each with keys like:
            {"source": "youtube", "title": "...", "url": "...", "metric": "views: 1.2M"}
    """
    g = get_connection()

    keywords_json = json.dumps(keywords or [], ensure_ascii=False)
    evidence_json = json.dumps(evidence or [], ensure_ascii=False)

    result = (
        g.V()
        .hasLabel("Trend")
        .has("title", title)
        .has("source", source)
        .fold()
        .coalesce(
            __.unfold(),
            __.addV("Trend").property("title", title).property("source", source),
        )
        .property("type", type)
        .property("date", date)
        .property("virality_score", virality_score)
        .property("decay_rate", decay_rate)
        .property("keywords", keywords_json)
        .property("evidence", evidence_json)
        .property("tier", tier or _infer_tier(decay_rate))
        .property("updated_at", datetime.now(timezone.utc).isoformat())
        .valueMap(True)
        .toList()
    )

    if not result:
        return json.dumps({"error": "Failed to upsert trend"}, ensure_ascii=False)

    trend = map_to_dict(result[0])
    was_new = "created_at" not in trend or trend.get("updated_at") == trend.get("created_at")

    return json.dumps(
        {"trend_id": str(trend.get("id", "")), "status": "created" if was_new else "updated"},
        ensure_ascii=False,
    )


# -------------------------------------------------------------------------
# 10. upsert_trend_spot
# -------------------------------------------------------------------------
def upsert_trend_spot(
    name: str,
    description: str = "",
    category: str = "",
    lat: float = 0.0,
    lng: float = 0.0,
    photo_worthy: bool = False,
) -> str:
    """Upsert a TrendSpot vertex in Neptune."""
    g = get_connection()

    result = (
        g.V()
        .hasLabel("TrendSpot")
        .has("name", name)
        .fold()
        .coalesce(
            __.unfold(),
            __.addV("TrendSpot").property("name", name),
        )
        .property("description", description)
        .property("category", category)
        .property("lat", lat)
        .property("lng", lng)
        .property("photo_worthy", photo_worthy)
        .property("updated_at", datetime.now(timezone.utc).isoformat())
        .valueMap(True)
        .toList()
    )

    if not result:
        return json.dumps({"error": "Failed to upsert trend spot"}, ensure_ascii=False)

    spot = map_to_dict(result[0])
    return json.dumps(
        {"spot_id": str(spot.get("id", "")), "status": "created" if not description else "updated"},
        ensure_ascii=False,
    )


# -------------------------------------------------------------------------
# 11. link_trend_to_spot
# -------------------------------------------------------------------------
def link_trend_to_spot(
    trend_title: str,
    trend_source: str,
    spot_name: str,
    edge_label: str = "FEATURES",
    city_name: str = "",
) -> str:
    """Link a Trend to a TrendSpot. Optionally link TrendSpot to City via LOCATED_IN."""
    g = get_connection()

    # Get Trend and TrendSpot vertices
    trends = g.V().hasLabel("Trend").has("title", trend_title).has("source", trend_source).toList()
    spots = g.V().hasLabel("TrendSpot").has("name", spot_name).toList()

    if not trends:
        return json.dumps({"error": f"Trend '{trend_title}' not found"}, ensure_ascii=False)
    if not spots:
        return json.dumps({"error": f"TrendSpot '{spot_name}' not found"}, ensure_ascii=False)

    trend_v = trends[0]
    spot_v = spots[0]

    # Validate edge_label
    if edge_label not in ("FILMED_AT", "FEATURES"):
        edge_label = "FEATURES"

    # Create Trend → TrendSpot edge (idempotent)
    existing_edge = (
        g.V(trend_v).outE(edge_label).where(__.inV().is_(spot_v)).toList()
    )
    if not existing_edge:
        g.V(trend_v).addE(edge_label).to(spot_v).next()

    # Link TrendSpot → City if city_name provided
    if city_name:
        cities = g.V().hasLabel("City").has("name", city_name).toList()
        if cities:
            city_v = cities[0]
            existing_loc = (
                g.V(spot_v).outE("LOCATED_IN").where(__.inV().is_(city_v)).toList()
            )
            if not existing_loc:
                g.V(spot_v).addE("LOCATED_IN").to(city_v).next()

    return json.dumps({"status": "linked"}, ensure_ascii=False)


# -------------------------------------------------------------------------
# 12. get_nearby_cities
# -------------------------------------------------------------------------
def get_nearby_cities(city: str, max_km: int = 100) -> str:
    """Find cities near the specified city within a maximum distance."""
    g = get_connection()

    results = (
        g.V().hasLabel("City").has("name", city)
        .outE("NEAR").has("distance_km", P.lte(max_km))
        .project("city", "distance_km")
        .by(__.inV().valueMap(True))
        .by(__.values("distance_km"))
        .order().by(__.select("distance_km"), Order.asc)
        .toList()
    )

    cities = []
    for r in results:
        city_data = map_to_dict(r["city"])
        city_data["distance_km"] = r.get("distance_km", 0)
        cities.append(city_data)

    return json.dumps({"nearby_cities": cities, "count": len(cities)}, ensure_ascii=False, default=str)


# -------------------------------------------------------------------------
# 13. get_cities_by_country
# -------------------------------------------------------------------------
def get_cities_by_country(country: str) -> str:
    """Get all cities for a country from the Knowledge Graph."""
    g = get_connection()
    results = (
        g.V().hasLabel("City").has("country", country)
        .valueMap("name", "region").toList()
    )
    cities = []
    for r in results:
        d = map_to_dict(r)
        name = d.get("name")
        if isinstance(name, list):
            name = name[0]
        region = d.get("region")
        if isinstance(region, list):
            region = region[0]
        if name:
            cities.append({"name": name, "region": region})
    return json.dumps({"country": country, "cities": cities, "count": len(cities)}, ensure_ascii=False)


# -------------------------------------------------------------------------
# 14. invalidate_cache
# -------------------------------------------------------------------------
_redis_client = None


def _get_redis():
    """Lazy-init Redis client for cache invalidation."""
    global _redis_client
    if _redis_client is None:
        import redis as redis_lib

        _redis_client = redis_lib.Redis(
            host=os.environ.get("REDIS_HOST", "REDACTED_VALKEY_HOST"),
            port=int(os.environ.get("REDIS_PORT", "6379")),
            ssl=True,
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
        )
    return _redis_client


def invalidate_cache(tool_pattern: str = "", flush_all: bool = False) -> str:
    """Delete cached MCP tool results from Valkey.

    Args:
        tool_pattern: Tool name to invalidate (e.g. 'get_trends').
                      Deletes all ``mcp:{tool_pattern}:*`` keys.
        flush_all: If True, delete ALL ``mcp:*`` keys.
    """
    try:
        client = _get_redis()

        if flush_all:
            pattern = "mcp:*"
        elif tool_pattern:
            pattern = f"mcp:{tool_pattern}:*"
        else:
            return json.dumps({"error": "Provide tool_pattern or set flush_all=true"}, ensure_ascii=False)

        deleted, cursor = 0, 0
        while True:
            cursor, keys = client.scan(cursor=cursor, match=pattern, count=100)
            if keys:
                deleted += client.delete(*keys)
            if cursor == 0:
                break

        logger.info("Cache invalidation: pattern=%s, deleted=%d keys", pattern, deleted)
        return json.dumps({"pattern": pattern, "deleted": deleted, "status": "ok"}, ensure_ascii=False)
    except Exception as e:
        logger.warning("Cache invalidation failed: %s", e)
        return json.dumps({"error": str(e), "status": "failed"}, ensure_ascii=False)
