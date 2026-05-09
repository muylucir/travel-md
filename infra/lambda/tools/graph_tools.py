"""Graph RAG tools (v3 schema) + Valkey caching for Lambda.

Schema reference: v3-graph-package/04_docs/SCHEMA_REFERENCE.md (2026-05-06).
Population: Kansai 4 cities (OSA/UKY/UKB/ARN), 6,691 vertices / 30,108 edges.

Vertex labels covered here (10): Country, City, Brand, Airline, Airport,
RepresentativeProduct, SaleProduct, FlightSegment, HotelStay, Attraction,
Hotel.

Notes:
- Package(old) -> SaleProduct. Primary key: saleProdCd.
- Hotel relation: SaleProduct -[:HAS_HOTEL_STAY]-> HotelStay -[:MATCHED_TO]-> Hotel
  (HotelStay may be dangling — A3 decision).
- Trend tools (HotTrend/SteadyTrend, IN_HOT_TREND/IN_STEADY_TREND) are
  intentionally not exposed here. The v3 graph contains placeholder
  trend vertices/edges (A6), but trend-related tools will be added in a
  later phase once a real classifier is in place.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os

from graph_client import execute_query, extract_node, reset_trace, get_trace

logger = logging.getLogger(__name__)

# -------------------------------------------------------------------------
# Valkey cache helpers
# -------------------------------------------------------------------------

CACHE_TTL = {
    "get_package": 43200,
    "search_packages": 21600,
    "get_routes_by_region": 43200,
    "get_attractions_by_city": 43200,
    "get_hotels_by_city": 43200,
    "get_similar_packages": 43200,
    "get_nearby_cities": 86400,
    "get_cities_by_country": 86400,
}
NEGATIVE_TTL = 300


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


def _attach_trace(payload: dict, *, source: str = "live") -> str:
    """Append _trace metadata and return a JSON string."""
    payload["_trace"] = {"source": source, "queries": get_trace()}
    return json.dumps(payload, ensure_ascii=False, default=str)


def _cached_with_trace(cached: str) -> str:
    """Mark a cached response as cache-hit (no fresh queries)."""
    try:
        data = json.loads(cached)
        if isinstance(data, dict):
            existing = data.get("_trace") if isinstance(data.get("_trace"), dict) else None
            data["_trace"] = {
                "source": "cache",
                "queries": existing.get("queries", []) if existing else [],
            }
            return json.dumps(data, ensure_ascii=False, default=str)
    except (ValueError, TypeError):
        pass
    return cached


# -------------------------------------------------------------------------
# 1. get_package
# -------------------------------------------------------------------------
def get_package(saleProdCd: str = "", package_code: str = "") -> str:
    """Retrieve full SaleProduct info: cities, attractions, hotels, flights, brand."""
    code = saleProdCd or package_code
    if not code:
        return json.dumps({"error": "saleProdCd is required"}, ensure_ascii=False)

    cache_key = _make_cache_key("get_package", code=code)
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()
    params = {"code": code}

    pkg_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code}) RETURN p", params
    )
    if not pkg_rows:
        result = _attach_trace({"error": f"SaleProduct '{code}' not found"})
        _cache_set(cache_key, result, NEGATIVE_TTL)
        return result

    package = extract_node(pkg_rows[0], "p")

    # Visited cities (provenance via VISITS_CITY) + arrival city (ARRIVES_IN)
    city_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code})-[v:VISITS_CITY]->(c:City) "
        "RETURN c, v.source AS source",
        params,
    )
    visit_cities = []
    for row in city_rows:
        cd = extract_node(row, "c")
        cd["source"] = row.get("source")
        visit_cities.append(cd)

    arr_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code})-[:ARRIVES_IN]->(c:City) RETURN c",
        params,
    )
    arrival_city = extract_node(arr_rows[0], "c") if arr_rows else None

    # Scheduled attractions (multigraph: schdDay, schtExprSqc)
    attr_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code})-[r:HAS_SCHEDULED_ATTRACTION]->(a:Attraction) "
        "RETURN a, r.schdDay AS schdDay, r.schtExprSqc AS schtExprSqc "
        "ORDER BY r.schdDay, r.schtExprSqc",
        params,
    )
    attractions = []
    for row in attr_rows:
        ad = extract_node(row, "a")
        ad["schdDay"] = row.get("schdDay")
        ad["schtExprSqc"] = row.get("schtExprSqc")
        attractions.append(ad)

    # Hotel stays + matched hotel master (left-join: A3 allows dangling)
    stay_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code})-[hs:HAS_HOTEL_STAY]->(s:HotelStay) "
        "OPTIONAL MATCH (s)-[:MATCHED_TO]->(h:Hotel) "
        "RETURN s, h, hs.schdDay AS schdDay "
        "ORDER BY hs.schdDay",
        params,
    )
    hotel_stays = []
    for row in stay_rows:
        stay = extract_node(row, "s")
        hotel = row.get("h")
        if isinstance(hotel, dict) and hotel.get("~properties"):
            stay["hotel"] = extract_node(row, "h")
        else:
            stay["hotel"] = None
        stay["schdDay"] = row.get("schdDay")
        hotel_stays.append(stay)

    # Flight segments + airports
    seg_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code})-[:HAS_FLIGHT_SEGMENT]->(f:FlightSegment) "
        "OPTIONAL MATCH (f)-[:DEPARTS_FROM_AIRPORT]->(da:Airport) "
        "OPTIONAL MATCH (f)-[:ARRIVES_AT_AIRPORT]->(aa:Airport) "
        "RETURN f, da, aa "
        "ORDER BY f.segReq",
        params,
    )
    segments = []
    for row in seg_rows:
        seg = extract_node(row, "f")
        if isinstance(row.get("da"), dict) and row["da"].get("~properties"):
            seg["depAirport"] = extract_node(row, "da")
        if isinstance(row.get("aa"), dict) and row["aa"].get("~properties"):
            seg["arrAirport"] = extract_node(row, "aa")
        segments.append(seg)

    # Brand + RepresentativeProduct
    brand_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code})-[:HAS_BRAND]->(b:Brand) RETURN b",
        params,
    )
    brand = extract_node(brand_rows[0], "b") if brand_rows else None

    rp_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code})-[:INSTANCE_OF]->(rp:RepresentativeProduct) RETURN rp",
        params,
    )
    representative = extract_node(rp_rows[0], "rp") if rp_rows else None

    result = {
        "saleProduct": package,
        "arrivalCity": arrival_city,
        "visitCities": visit_cities,
        "attractions": attractions,
        "hotelStays": hotel_stays,
        "flightSegments": segments,
        "brand": brand,
        "representative": representative,
    }
    result_str = _attach_trace(result)
    _cache_set(cache_key, result_str, CACHE_TTL["get_package"])
    return result_str


# -------------------------------------------------------------------------
# 2. search_packages
# -------------------------------------------------------------------------
def search_packages(
    destination: str,
    nights: int = 0,
    theme_key: str = "",
    season_quarter: int = 0,
) -> str:
    """Search SaleProducts. v3: matches by arrival city or visited city.

    theme_key/season_quarter are matched indirectly through scheduled
    attractions' IN_THEME / BEST_IN_SEASON weights (>0).
    """
    cache_key = _make_cache_key(
        "search_packages",
        destination=destination,
        nights=nights,
        theme_key=theme_key,
        season_quarter=season_quarter,
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()

    # destination 매칭은 ARRIVES_IN(SaleProduct.arrCityNm/arrCityCd) 또는
    # VISITS_CITY 둘 중 하나에 걸리면 OK.
    # OpenCypher (Neptune) 는 OPTIONAL MATCH 다음 MATCH 와 EXISTS{...} 서브쿼리를
    # 모두 거부하므로, WHERE 절의 pattern expression 을 사용한다.
    match_lines = ["MATCH (p:SaleProduct)"]
    where_parts: list[str] = []
    params: dict = {}

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

    if destination:
        where_parts.append(
            "(p.arrCityNm = $dest OR p.arrCityCd = $dest OR "
            "(p)-[:VISITS_CITY]->(:City {name: $dest}) OR "
            "(p)-[:VISITS_CITY]->(:City {code: $dest}))"
        )
        params["dest"] = destination

    query = "\n".join(match_lines)
    if where_parts:
        query += "\nWHERE " + " AND ".join(where_parts)
    query += "\nRETURN DISTINCT p LIMIT 20"

    rows = execute_query(query, params)
    packages = [extract_node(row, "p") for row in rows]

    result_str = _attach_trace({"packages": packages, "count": len(packages)})
    _cache_set(cache_key, result_str, CACHE_TTL["search_packages"])
    return result_str


# -------------------------------------------------------------------------
# 3. get_routes_by_region
# -------------------------------------------------------------------------
def get_routes_by_region(region: str = "", arrival_city: str = "") -> str:
    """Retrieve flight segments arriving at the given city/region.

    v3 has no Route label; we expose distinct (depAirport -> arrAirport)
    pairs via FlightSegment for SaleProducts whose ARRIVES_IN city matches.
    """
    target = arrival_city or region
    if not target:
        return json.dumps({"error": "arrival_city is required"}, ensure_ascii=False)

    cache_key = _make_cache_key("get_routes_by_region", target=target)
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()
    rows = execute_query(
        "MATCH (p:SaleProduct)-[:ARRIVES_IN]->(c:City) "
        "WHERE c.name = $t OR c.code = $t "
        "MATCH (p)-[:HAS_FLIGHT_SEGMENT]->(f:FlightSegment) "
        "RETURN DISTINCT f.depAirportCode AS depAirport, f.depAirportName AS depAirportName, "
        "       f.arrAirportCode AS arrAirport, f.arrAirportName AS arrAirportName, "
        "       f.airlCd AS airlineCode, f.airlNm AS airlineName, f.segReq AS segReq",
        {"t": target},
    )
    routes = [
        {
            "depAirport": r.get("depAirport"),
            "depAirportName": r.get("depAirportName"),
            "arrAirport": r.get("arrAirport"),
            "arrAirportName": r.get("arrAirportName"),
            "airlineCode": r.get("airlineCode"),
            "airlineName": r.get("airlineName"),
            "segReq": r.get("segReq"),
        }
        for r in rows
    ]
    result_str = _attach_trace({"routes": routes, "count": len(routes)})
    _cache_set(cache_key, result_str, CACHE_TTL["get_routes_by_region"])
    return result_str


# -------------------------------------------------------------------------
# 4. get_attractions_by_city
# -------------------------------------------------------------------------
def get_attractions_by_city(city: str, attraction_type: str = "", category: str = "") -> str:
    """Retrieve attractions in a city. v3 edge: (Attraction)-[:IN_CITY]->(City).

    `category` is a legacy alias for `attraction_type` (matches Attraction.type).
    """
    type_filter = attraction_type or category
    cache_key = _make_cache_key("get_attractions_by_city", city=city, t=type_filter)
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()
    if type_filter:
        query = (
            "MATCH (a:Attraction)-[:IN_CITY]->(c:City) "
            "WHERE (c.name = $city OR c.code = $city) AND a.type = $t "
            "RETURN a LIMIT 200"
        )
        params = {"city": city, "t": type_filter}
    else:
        query = (
            "MATCH (a:Attraction)-[:IN_CITY]->(c:City) "
            "WHERE c.name = $city OR c.code = $city "
            "RETURN a LIMIT 200"
        )
        params = {"city": city}

    rows = execute_query(query, params)
    attractions = [extract_node(row, "a") for row in rows]
    result_str = _attach_trace(
        {"attractions": attractions, "count": len(attractions)}
    )
    _cache_set(cache_key, result_str, CACHE_TTL["get_attractions_by_city"])
    return result_str


# -------------------------------------------------------------------------
# 5. get_hotels_by_city
# -------------------------------------------------------------------------
def get_hotels_by_city(city: str, grade: str = "") -> str:
    """Retrieve hotels in a city. v3 edge: (Hotel)-[:IN_CITY]->(City).

    Note: v3 Hotel has no `has_onsen` property — filter dropped.
    """
    cache_key = _make_cache_key("get_hotels_by_city", city=city, grade=grade)
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()
    where_parts = ["(c.name = $city OR c.code = $city)"]
    params: dict = {"city": city}
    if grade:
        where_parts.append("h.grade = $grade")
        params["grade"] = grade

    query = (
        "MATCH (h:Hotel)-[:IN_CITY]->(c:City) "
        "WHERE " + " AND ".join(where_parts) + " "
        "RETURN h LIMIT 200"
    )

    rows = execute_query(query, params)
    hotels = [extract_node(row, "h") for row in rows]
    result_str = _attach_trace({"hotels": hotels, "count": len(hotels)})
    _cache_set(cache_key, result_str, CACHE_TTL["get_hotels_by_city"])
    return result_str


# -------------------------------------------------------------------------
# 6. get_similar_packages
# -------------------------------------------------------------------------
def get_similar_packages(saleProdCd: str = "", package_code: str = "") -> str:
    """Find similar SaleProducts. v3 has no SIMILAR_TO; we use sibling
    products under the same RepresentativeProduct (INSTANCE_OF), then
    fall back to same arrCityCd.
    """
    code = saleProdCd or package_code
    if not code:
        return json.dumps({"error": "saleProdCd is required"}, ensure_ascii=False)

    cache_key = _make_cache_key("get_similar_packages", code=code)
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()
    rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code})-[:INSTANCE_OF]->(rp:RepresentativeProduct) "
        "MATCH (p2:SaleProduct)-[:INSTANCE_OF]->(rp) "
        "WHERE p2.saleProdCd <> $code "
        "RETURN p2 LIMIT 10",
        {"code": code},
    )

    if not rows:
        rows = execute_query(
            "MATCH (p:SaleProduct {saleProdCd: $code}) "
            "MATCH (p2:SaleProduct) "
            "WHERE p2.saleProdCd <> $code AND p2.arrCityCd = p.arrCityCd "
            "RETURN p2 LIMIT 10",
            {"code": code},
        )

    similar = [{"saleProduct": extract_node(r, "p2")} for r in rows]
    result_str = _attach_trace(
        {"similar_packages": similar, "count": len(similar)}
    )
    _cache_set(cache_key, result_str, CACHE_TTL["get_similar_packages"])
    return result_str


# -------------------------------------------------------------------------
# 7. get_nearby_cities
# -------------------------------------------------------------------------
def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def get_nearby_cities(city: str, max_km: int = 100) -> str:
    """Find cities within max_km of the given city.

    v3 has no NEAR edge — distance is computed in-process from
    City.centerLat/centerLng. Limited to cities sharing the same country
    as the source city for relevance.
    """
    cache_key = _make_cache_key("get_nearby_cities", city=city, max_km=max_km)
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()
    src_rows = execute_query(
        "MATCH (c:City) WHERE c.name = $city OR c.code = $city "
        "RETURN c.code AS code, c.name AS name, c.countryCode AS country, "
        "       c.centerLat AS lat, c.centerLng AS lng LIMIT 1",
        {"city": city},
    )
    if not src_rows:
        result = _attach_trace(
            {"nearby_cities": [], "count": 0, "error": f"City '{city}' not found"}
        )
        _cache_set(cache_key, result, NEGATIVE_TTL)
        return result

    src = src_rows[0]
    src_lat, src_lng = src.get("lat"), src.get("lng")
    if src_lat is None or src_lng is None:
        result = _attach_trace(
            {
                "nearby_cities": [],
                "count": 0,
                "error": f"City '{city}' has no coordinates",
            }
        )
        _cache_set(cache_key, result, NEGATIVE_TTL)
        return result

    cand_rows = execute_query(
        "MATCH (c:City) "
        "WHERE c.countryCode = $country AND c.code <> $code "
        "  AND c.centerLat IS NOT NULL AND c.centerLng IS NOT NULL "
        "RETURN c.code AS code, c.name AS name, c.countryCode AS countryCode, "
        "       c.centerLat AS lat, c.centerLng AS lng",
        {"country": src.get("country"), "code": src.get("code")},
    )

    nearby = []
    for r in cand_rows:
        try:
            d = _haversine_km(float(src_lat), float(src_lng), float(r["lat"]), float(r["lng"]))
        except (TypeError, ValueError):
            continue
        if d <= max_km:
            nearby.append(
                {
                    "code": r.get("code"),
                    "name": r.get("name"),
                    "countryCode": r.get("countryCode"),
                    "distance_km": round(d, 1),
                }
            )
    nearby.sort(key=lambda x: x["distance_km"])

    result_str = _attach_trace({"nearby_cities": nearby, "count": len(nearby)})
    _cache_set(cache_key, result_str, CACHE_TTL["get_nearby_cities"])
    return result_str


# -------------------------------------------------------------------------
# 8. get_cities_by_country
# -------------------------------------------------------------------------
def get_cities_by_country(country: str) -> str:
    """List cities for a country. `country` is matched against countryCode
    (e.g. 'JP') or countryName (e.g. '일본')."""
    cache_key = _make_cache_key("get_cities_by_country", country=country)
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()
    rows = execute_query(
        "MATCH (c:City) "
        "WHERE c.countryCode = $country OR c.countryName = $country "
        "RETURN c.code AS code, c.name AS name, c.englishName AS englishName, "
        "       c.countryCode AS countryCode",
        {"country": country},
    )
    cities = [
        {
            "code": r.get("code"),
            "name": r.get("name"),
            "englishName": r.get("englishName"),
            "countryCode": r.get("countryCode"),
        }
        for r in rows
        if r.get("code")
    ]
    result_str = _attach_trace(
        {"country": country, "cities": cities, "count": len(cities)}
    )
    _cache_set(cache_key, result_str, CACHE_TTL["get_cities_by_country"])
    return result_str


# -------------------------------------------------------------------------
# 9. invalidate_cache
# -------------------------------------------------------------------------
_redis_client = None


def _get_redis():
    global _redis_client
    if _redis_client is None:
        import redis as redis_lib

        _redis_client = redis_lib.Redis(
            host=os.environ.get("REDIS_HOST", "localhost"),
            port=int(os.environ.get("REDIS_PORT", "6379")),
            ssl=True,
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
        )
    return _redis_client


def invalidate_cache(tool_pattern: str = "", flush_all: bool = False) -> str:
    """Delete cached MCP tool results from Valkey."""
    try:
        client = _get_redis()

        if flush_all:
            pattern = "mcp:*"
        elif tool_pattern:
            pattern = f"mcp:{tool_pattern}:*"
        else:
            return json.dumps(
                {"error": "Provide tool_pattern or set flush_all=true"}, ensure_ascii=False
            )

        deleted, cursor = 0, 0
        while True:
            cursor, keys = client.scan(cursor=cursor, match=pattern, count=100)
            if keys:
                deleted += client.delete(*keys)
            if cursor == 0:
                break

        logger.info("Cache invalidation: pattern=%s, deleted=%d keys", pattern, deleted)
        return json.dumps(
            {"pattern": pattern, "deleted": deleted, "status": "ok"}, ensure_ascii=False
        )
    except Exception as e:
        logger.warning("Cache invalidation failed: %s", e)
        return json.dumps({"error": str(e), "status": "failed"}, ensure_ascii=False)
