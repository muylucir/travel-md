"""Graph RAG tools + Valkey caching + cache invalidation for Lambda.

Uses Neptune OpenCypher (HTTPS) via boto3 neptunedata client.
Read tools are cached in Valkey with per-tool TTLs. Write tools
bypass the cache. The ``invalidate_cache`` tool deletes cached keys.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone

from graph_client import execute_query, extract_node, parse_json_field

logger = logging.getLogger(__name__)

# -------------------------------------------------------------------------
# Valkey cache helpers
# -------------------------------------------------------------------------

CACHE_TTL = {
    "get_package": 43200,            # 12h — semi-static
    "search_packages": 21600,        # 6h  — dynamic (query-dependent)
    "get_routes_by_region": 43200,   # 12h — semi-static
    "get_attractions_by_city": 43200,# 12h — semi-static
    "get_hotels_by_city": 43200,     # 12h — semi-static
    "get_trends": 3600,              # 1h  — volatile
    "get_similar_packages": 43200,   # 12h — semi-static
    "get_nearby_cities": 86400,      # 24h — static
    "get_cities_by_country": 86400,  # 24h — static
}
NEGATIVE_TTL = 300  # 5min for "not found" results


def _make_cache_key(tool_name: str, **kwargs) -> str:
    args_str = json.dumps(kwargs, sort_keys=True, ensure_ascii=False, default=str)
    args_hash = hashlib.md5(args_str.encode()).hexdigest()[:12]
    return f"mcp:{tool_name}:{args_hash}"


def _cache_get(key: str) -> str | None:
    try:
        return _get_redis().get(key)
    except Exception:
        return None


def _cache_set(key: str, value: str, ttl: int) -> None:
    try:
        _get_redis().setex(key, ttl, value)
    except Exception:
        pass


# -------------------------------------------------------------------------
# 1. get_package
# -------------------------------------------------------------------------
def get_package(package_code: str) -> str:
    """Retrieve complete package information including related entities."""
    cache_key = _make_cache_key("get_package", package_code=package_code)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    params = {"code": package_code}

    # Package node
    pkg_rows = execute_query(
        "MATCH (p:Package {code: $code}) RETURN p",
        params,
    )
    if not pkg_rows:
        result = json.dumps({"error": f"Package '{package_code}' not found"}, ensure_ascii=False)
        _cache_set(cache_key, result, NEGATIVE_TTL)
        return result

    package = extract_node(pkg_rows[0], "p")
    for field in ("season", "hashtags", "guide_fee"):
        if field in package:
            package[field] = parse_json_field(package[field])

    # Cities via VISITS edges (with edge properties)
    city_rows = execute_query(
        "MATCH (p:Package {code: $code})-[v:VISITS]->(c:City) RETURN c, v.day AS day, v.`order` AS order",
        params,
    )
    city_list = []
    for row in city_rows:
        city_data = extract_node(row, "c")
        city_data["day"] = row.get("day")
        city_data["order"] = row.get("order")
        city_list.append(city_data)

    # Attractions via INCLUDES edges (with edge properties)
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

    # Hotels
    hotel_rows = execute_query(
        "MATCH (p:Package {code: $code})-[:INCLUDES_HOTEL]->(h:Hotel) RETURN h",
        params,
    )
    hotel_list = [extract_node(row, "h") for row in hotel_rows]

    # Routes via DEPARTS_ON edges (with edge type)
    route_rows = execute_query(
        "MATCH (p:Package {code: $code})-[d:DEPARTS_ON]->(r:Route) RETURN r, d.type AS flight_type",
        params,
    )
    route_list = []
    for row in route_rows:
        route_data = extract_node(row, "r")
        route_data["flight_type"] = row.get("flight_type")
        route_list.append(route_data)

    # Themes
    theme_rows = execute_query(
        "MATCH (p:Package {code: $code})-[:TAGGED]->(t:Theme) RETURN t",
        params,
    )
    theme_list = [extract_node(row, "t") for row in theme_rows]

    # Activities via HAS_ACTIVITY edges (with edge day)
    act_rows = execute_query(
        "MATCH (p:Package {code: $code})-[ha:HAS_ACTIVITY]->(a) RETURN a, ha.day AS day",
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
    result_str = json.dumps(result, ensure_ascii=False, default=str)
    _cache_set(cache_key, result_str, CACHE_TTL["get_package"])
    return result_str


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
    cache_key = _make_cache_key("search_packages", destination=destination, theme=theme,
                                season=season, nights=nights, max_budget=max_budget,
                                shopping_max=shopping_max)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

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

    result_str = json.dumps({"packages": packages, "count": len(packages)}, ensure_ascii=False, default=str)
    _cache_set(cache_key, result_str, CACHE_TTL["search_packages"])
    return result_str


# -------------------------------------------------------------------------
# 3. get_routes_by_region
# -------------------------------------------------------------------------
def get_routes_by_region(region: str) -> str:
    """Retrieve available flight routes for a region."""
    cache_key = _make_cache_key("get_routes_by_region", region=region)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    rows = execute_query(
        "MATCH (r:Route)-[:TO]->(c:City {region: $region}) RETURN r",
        {"region": region},
    )
    routes = [extract_node(row, "r") for row in rows]
    result_str = json.dumps({"routes": routes, "count": len(routes)}, ensure_ascii=False, default=str)
    _cache_set(cache_key, result_str, CACHE_TTL["get_routes_by_region"])
    return result_str


# -------------------------------------------------------------------------
# 4. get_attractions_by_city
# -------------------------------------------------------------------------
def get_attractions_by_city(city: str, category: str = "") -> str:
    """Retrieve attractions in a city, optionally filtered by category."""
    cache_key = _make_cache_key("get_attractions_by_city", city=city, category=category)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    if category:
        query = "MATCH (:City {name: $city})-[:HAS_ATTRACTION]->(a:Attraction {category: $category}) RETURN a"
        params = {"city": city, "category": category}
    else:
        query = "MATCH (:City {name: $city})-[:HAS_ATTRACTION]->(a:Attraction) RETURN a"
        params = {"city": city}

    rows = execute_query(query, params)
    attractions = [extract_node(row, "a") for row in rows]
    result_str = json.dumps({"attractions": attractions, "count": len(attractions)}, ensure_ascii=False, default=str)
    _cache_set(cache_key, result_str, CACHE_TTL["get_attractions_by_city"])
    return result_str


# -------------------------------------------------------------------------
# 5. get_hotels_by_city
# -------------------------------------------------------------------------
def get_hotels_by_city(city: str, grade: str = "", has_onsen: bool = False) -> str:
    """Retrieve hotels in a city, optionally filtered by grade and onsen."""
    cache_key = _make_cache_key("get_hotels_by_city", city=city, grade=grade, has_onsen=has_onsen)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    where_parts = []
    params: dict = {"city": city}

    if grade:
        where_parts.append("h.grade = $grade")
        params["grade"] = grade
    if has_onsen:
        where_parts.append("h.has_onsen = true")

    query = "MATCH (:City {name: $city})-[:HAS_HOTEL]->(h:Hotel)"
    if where_parts:
        query += " WHERE " + " AND ".join(where_parts)
    query += " RETURN h"

    rows = execute_query(query, params)
    hotels = [extract_node(row, "h") for row in rows]
    result_str = json.dumps({"hotels": hotels, "count": len(hotels)}, ensure_ascii=False, default=str)
    _cache_set(cache_key, result_str, CACHE_TTL["get_hotels_by_city"])
    return result_str


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
    cache_key = _make_cache_key("get_trends", region=region, country=country, city=city, min_score=min_score)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    # Build location filter for the City node
    params: dict = {"min_score": min_score}
    if city:
        city_filter = "{name: $location}"
        params["location"] = city
    elif region:
        city_filter = "{region: $location}"
        params["location"] = region
    elif country:
        city_filter = "{country: $location}"
        params["location"] = country
    else:
        city_filter = ""

    query = (
        f"MATCH (t:Trend)-[rel:FILMED_AT|FEATURES]->(ts:TrendSpot)-[:LOCATED_IN]->(c:City {city_filter}) "
        f"WHERE t.virality_score >= $min_score "
        f"WITH t, collect(DISTINCT ts) AS spots "
        f"RETURN t, spots"
    )

    raw = execute_query(query, params)

    trends = []
    for item in raw:
        trend_data = extract_node(item, "t")
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

        spots_raw = item.get("spots", [])
        spots = [extract_node({"s": s}, "s") for s in spots_raw] if spots_raw else []
        tier = trend_data.get("tier") or _infer_tier(float(decay) if decay else 0.1)
        trends.append({
            "trend": {**trend_data, "tier": tier},
            "effective_score": round(effective, 1),
            "spots": spots,
        })

    trends.sort(key=lambda t: t["effective_score"], reverse=True)
    trends = trends[:10]

    result_str = json.dumps({"trends": trends, "count": len(trends)}, ensure_ascii=False, default=str)
    _cache_set(cache_key, result_str, CACHE_TTL["get_trends"])
    return result_str


# -------------------------------------------------------------------------
# 7. get_similar_packages
# -------------------------------------------------------------------------
def get_similar_packages(package_code: str) -> str:
    """Find packages similar to the given package via SIMILAR_TO edges."""
    cache_key = _make_cache_key("get_similar_packages", package_code=package_code)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

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

    result_str = json.dumps({"similar_packages": packages, "count": len(packages)}, ensure_ascii=False, default=str)
    _cache_set(cache_key, result_str, CACHE_TTL["get_similar_packages"])
    return result_str


# -------------------------------------------------------------------------
# 8. get_nearby_cities
# -------------------------------------------------------------------------
def get_nearby_cities(city: str, max_km: int = 100) -> str:
    """Find cities near the specified city within a maximum distance."""
    cache_key = _make_cache_key("get_nearby_cities", city=city, max_km=max_km)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    rows = execute_query(
        "MATCH (:City {name: $city})-[n:NEAR]->(c2:City) "
        "WHERE n.distance_km <= $max_km "
        "RETURN c2, n.distance_km AS distance_km "
        "ORDER BY n.distance_km ASC",
        {"city": city, "max_km": max_km},
    )

    cities = []
    for row in rows:
        city_data = extract_node(row, "c2")
        city_data["distance_km"] = row.get("distance_km", 0)
        cities.append(city_data)

    result_str = json.dumps({"nearby_cities": cities, "count": len(cities)}, ensure_ascii=False, default=str)
    _cache_set(cache_key, result_str, CACHE_TTL["get_nearby_cities"])
    return result_str


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
    keywords_json = json.dumps(keywords or [], ensure_ascii=False)
    evidence_json = json.dumps(evidence or [], ensure_ascii=False)
    resolved_tier = tier or _infer_tier(decay_rate)
    updated_at = datetime.now(timezone.utc).isoformat()

    rows = execute_query(
        "MERGE (t:Trend {title: $title, source: $source}) "
        "ON CREATE SET t.type = $type, t.date = $date, "
        "  t.virality_score = $virality_score, t.decay_rate = $decay_rate, "
        "  t.keywords = $keywords, t.evidence = $evidence, "
        "  t.tier = $tier, t.updated_at = $updated_at, t.created_at = $updated_at "
        "ON MATCH SET t.type = $type, t.date = $date, "
        "  t.virality_score = $virality_score, t.decay_rate = $decay_rate, "
        "  t.keywords = $keywords, t.evidence = $evidence, "
        "  t.tier = $tier, t.updated_at = $updated_at "
        "RETURN t, t.created_at = t.updated_at AS is_new",
        {
            "title": title,
            "source": source,
            "type": type,
            "date": date,
            "virality_score": virality_score,
            "decay_rate": decay_rate,
            "keywords": keywords_json,
            "evidence": evidence_json,
            "tier": resolved_tier,
            "updated_at": updated_at,
        },
    )

    if not rows:
        return json.dumps({"error": "Failed to upsert trend"}, ensure_ascii=False)

    trend = extract_node(rows[0], "t")
    is_new = rows[0].get("is_new", False)

    return json.dumps(
        {"trend_id": str(trend.get("id", "")), "status": "created" if is_new else "updated"},
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
    updated_at = datetime.now(timezone.utc).isoformat()

    rows = execute_query(
        "MERGE (ts:TrendSpot {name: $name}) "
        "ON CREATE SET ts.description = $description, ts.category = $category, "
        "  ts.lat = $lat, ts.lng = $lng, ts.photo_worthy = $photo_worthy, "
        "  ts.updated_at = $updated_at, ts.created_at = $updated_at "
        "ON MATCH SET ts.description = $description, ts.category = $category, "
        "  ts.lat = $lat, ts.lng = $lng, ts.photo_worthy = $photo_worthy, "
        "  ts.updated_at = $updated_at "
        "RETURN ts, ts.created_at = ts.updated_at AS is_new",
        {
            "name": name,
            "description": description,
            "category": category,
            "lat": lat,
            "lng": lng,
            "photo_worthy": photo_worthy,
            "updated_at": updated_at,
        },
    )

    if not rows:
        return json.dumps({"error": "Failed to upsert trend spot"}, ensure_ascii=False)

    spot = extract_node(rows[0], "ts")
    is_new = rows[0].get("is_new", False)
    return json.dumps(
        {"spot_id": str(spot.get("id", "")), "status": "created" if is_new else "updated"},
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
    # Validate edge_label
    if edge_label not in ("FILMED_AT", "FEATURES"):
        edge_label = "FEATURES"

    params = {"title": trend_title, "source": trend_source, "spot_name": spot_name}

    # MERGE Trend -> TrendSpot edge (idempotent)
    # Cypher does not allow parameterized relationship types, so we use if/else
    if edge_label == "FILMED_AT":
        query = (
            "MATCH (t:Trend {title: $title, source: $source}) "
            "MATCH (ts:TrendSpot {name: $spot_name}) "
            "MERGE (t)-[:FILMED_AT]->(ts) "
            "RETURN t, ts"
        )
    else:
        query = (
            "MATCH (t:Trend {title: $title, source: $source}) "
            "MATCH (ts:TrendSpot {name: $spot_name}) "
            "MERGE (t)-[:FEATURES]->(ts) "
            "RETURN t, ts"
        )

    rows = execute_query(query, params)
    if not rows:
        return json.dumps(
            {"error": f"Trend '{trend_title}' or TrendSpot '{spot_name}' not found"},
            ensure_ascii=False,
        )

    # Link TrendSpot -> City if city_name provided
    if city_name:
        execute_query(
            "MATCH (ts:TrendSpot {name: $spot_name}) "
            "MATCH (c:City {name: $city_name}) "
            "MERGE (ts)-[:LOCATED_IN]->(c)",
            {"spot_name": spot_name, "city_name": city_name},
        )

    return json.dumps({"status": "linked"}, ensure_ascii=False)


# -------------------------------------------------------------------------
# 12. get_cities_by_country
# -------------------------------------------------------------------------
def get_cities_by_country(country: str) -> str:
    """Get all cities for a country from the Knowledge Graph."""
    cache_key = _make_cache_key("get_cities_by_country", country=country)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    rows = execute_query(
        "MATCH (c:City {country: $country}) RETURN c.name AS name, c.region AS region",
        {"country": country},
    )
    cities = [{"name": row["name"], "region": row.get("region")} for row in rows if row.get("name")]
    result_str = json.dumps({"country": country, "cities": cities, "count": len(cities)}, ensure_ascii=False)
    _cache_set(cache_key, result_str, CACHE_TTL["get_cities_by_country"])
    return result_str


# -------------------------------------------------------------------------
# 13. invalidate_cache
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
