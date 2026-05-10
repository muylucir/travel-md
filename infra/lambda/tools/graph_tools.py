"""Graph RAG tools (v3 schema, score-first redesign).

Schema reference: v3-graph-package/04_docs/SCHEMA_REFERENCE.md (2026-05-06).
Population: Kansai 4 cities (OSA/UKY/UKB/ARN), 6,691 vertices / 30,108 edges.

Design principles (see docs/redesign/TOOL_DESIGN.md):
- Score functions encoded directly in Cypher (no "raw catalog" tools)
- Ranked top-k + rationale + breakdown returned to LLM
- Cache key = (tool_name, all_params) → intent-level caching
- Trend tools intentionally not exposed (placeholder phase)

Tool catalog (10 tools):
  Skeleton phase:
    1. get_reference_package
    2. find_similar_packages
    3. recommend_route
  Day Detail phase:
    4. recommend_attractions     ⭐ core ranked function
    5. recommend_hotels
    6. get_attraction_neighbors
    7. get_attraction_detail
  Meta:
    8. explain_score
    9. plan_context_bundle
    10. invalidate_cache
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
from typing import Any

from graph_client import execute_query, extract_node, reset_trace, get_trace

logger = logging.getLogger(__name__)


# =============================================================================
# Cache helpers
# =============================================================================

CACHE_TTL = {
    "get_reference_package": 43200,    # 12h
    "find_similar_packages": 43200,    # 12h
    "recommend_route": 43200,          # 12h
    "recommend_attractions": 21600,    # 6h
    "recommend_hotels": 43200,         # 12h
    "get_attraction_neighbors": 86400, # 24h
    "get_attraction_detail": 86400,    # 24h
    "explain_score": 86400,            # 24h
    "plan_context_bundle": 21600,      # 6h
}
NEGATIVE_TTL = 300  # 5min for "not found"


def _make_cache_key(tool_name: str, **kwargs) -> str:
    """Stable cache key from tool name + canonical JSON of arguments."""
    # Normalize: sort lists with primitives so equivalent inputs hash the same
    norm = _canonicalize(kwargs)
    args_str = json.dumps(norm, sort_keys=True, ensure_ascii=False, default=str)
    args_hash = hashlib.md5(args_str.encode()).hexdigest()[:12]
    return f"mcp:{tool_name}:{args_hash}"


def _canonicalize(value: Any) -> Any:
    if isinstance(value, list):
        items = [_canonicalize(v) for v in value]
        # Sort if all primitives — order shouldn't matter for set-like inputs
        if all(isinstance(x, (str, int, float, bool, type(None))) for x in items):
            try:
                return sorted(items, key=lambda x: (x is None, str(x)))
            except TypeError:
                return items
        return items
    if isinstance(value, dict):
        return {k: _canonicalize(v) for k, v in value.items()}
    return value


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
    payload["_trace"] = {"source": source, "queries": get_trace()}
    return json.dumps(payload, ensure_ascii=False, default=str)


def _cached_with_trace(cached: str) -> str:
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


# =============================================================================
# ID normalization helpers
# =============================================================================

def _normalize_attraction_id(value: str) -> str:
    """Accept either 'LJP00233005' or 'Attraction:LJP00233005'.
    Returns raw id ('LJP00233005') for matching against a.id property.
    Cypher we run uses `id(a) = $internal_id` to compare to internal node id;
    we choose the property-match form for portability.
    """
    if not value:
        return ""
    if value.startswith("Attraction:"):
        return value.split(":", 1)[1]
    return value


def _attraction_node_id(value: str) -> str:
    """Return the full Neptune internal id 'Attraction:LJP_xxx'."""
    if not value:
        return ""
    if value.startswith("Attraction:"):
        return value
    return f"Attraction:{value}"


def _parse_json_list(s: Any) -> list:
    if isinstance(s, list):
        return s
    if isinstance(s, str) and s:
        try:
            v = json.loads(s)
            return v if isinstance(v, list) else []
        except (ValueError, TypeError):
            return []
    return []


# =============================================================================
# 1. get_reference_package
# =============================================================================

def get_reference_package(saleProdCd: str = "", package_code: str = "") -> str:
    """Retrieve full SaleProduct details (cities, attractions, hotels, flights, brand)."""
    code = saleProdCd or package_code
    if not code:
        return json.dumps({"error": "saleProdCd is required"}, ensure_ascii=False)

    cache_key = _make_cache_key("get_reference_package", code=code)
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

    visit_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code})-[v:VISITS_CITY]->(c:City) "
        "RETURN c, v.source AS source",
        params,
    )
    visit_cities = []
    for row in visit_rows:
        cd = extract_node(row, "c")
        cd["source"] = row.get("source")
        visit_cities.append(cd)

    arr_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code})-[:ARRIVES_IN]->(c:City) RETURN c",
        params,
    )
    arrival_city = extract_node(arr_rows[0], "c") if arr_rows else None

    attr_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code})-[r:HAS_SCHEDULED_ATTRACTION]->(a:Attraction) "
        "OPTIONAL MATCH (a)-[:IN_CITY]->(c:City) "
        "RETURN a, c.name AS cityName, "
        "       r.schdDay AS schdDay, r.schtExprSqc AS schtExprSqc "
        "ORDER BY r.schdDay, r.schtExprSqc",
        params,
    )
    scheduled_attractions = []
    for row in attr_rows:
        ad = extract_node(row, "a")
        ad["schdDay"] = row.get("schdDay")
        ad["schtExprSqc"] = row.get("schtExprSqc")
        # Tag with the resolved city so downstream similarity preservation
        # can place each attraction on a day whose cities match.
        ad["cityName"] = row.get("cityName")
        scheduled_attractions.append(ad)

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
        h = row.get("h")
        if isinstance(h, dict) and h.get("~properties"):
            stay["hotel"] = extract_node(row, "h")
        else:
            stay["hotel"] = None
        stay["schdDay"] = row.get("schdDay")
        hotel_stays.append(stay)

    seg_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code})-[:HAS_FLIGHT_SEGMENT]->(f:FlightSegment) "
        "OPTIONAL MATCH (f)-[:DEPARTS_FROM_AIRPORT]->(da:Airport) "
        "OPTIONAL MATCH (f)-[:ARRIVES_AT_AIRPORT]->(aa:Airport) "
        "RETURN f, da, aa ORDER BY f.segReq",
        params,
    )
    flight_segments = []
    for row in seg_rows:
        seg = extract_node(row, "f")
        if isinstance(row.get("da"), dict) and row["da"].get("~properties"):
            seg["depAirport"] = extract_node(row, "da")
        if isinstance(row.get("aa"), dict) and row["aa"].get("~properties"):
            seg["arrAirport"] = extract_node(row, "aa")
        flight_segments.append(seg)

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

    result_str = _attach_trace(
        {
            "saleProduct": package,
            "arrivalCity": arrival_city,
            "visitCities": visit_cities,
            "scheduledAttractions": scheduled_attractions,
            "hotelStays": hotel_stays,
            "flightSegments": flight_segments,
            "brand": brand,
            "representative": representative,
        }
    )
    _cache_set(cache_key, result_str, CACHE_TTL["get_reference_package"])
    return result_str


# =============================================================================
# 2. find_similar_packages
# =============================================================================

def find_similar_packages(
    saleProdCd: str = "",
    theme_key: str = "",
    season_quarter: int = 0,
    brand: str = "",
    alpha: float = 0.5,
    beta: float = 0.3,
    gamma: float = 0.2,
    limit: int = 10,
) -> str:
    """5-Layer score-based similar SaleProducts.

    Score = α * city_jaccard(p, ref) + β * avg(IN_THEME[theme_key].weight)
          + γ * avg(BEST_IN_SEASON[Q].weight) + small brand match bonus
    """
    cache_key = _make_cache_key(
        "find_similar_packages",
        saleProdCd=saleProdCd,
        theme_key=theme_key,
        season_quarter=season_quarter,
        brand=brand,
        alpha=alpha,
        beta=beta,
        gamma=gamma,
        limit=limit,
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()

    ref_cities: list[str] = []
    if saleProdCd:
        ref_rows = execute_query(
            "MATCH (p:SaleProduct {saleProdCd: $code}) "
            "OPTIONAL MATCH (p)-[:VISITS_CITY|ARRIVES_IN]->(c:City) "
            "RETURN collect(DISTINCT c.name) AS cities",
            {"code": saleProdCd},
        )
        if ref_rows:
            ref_cities = [c for c in (ref_rows[0].get("cities") or []) if c]

    # Build the main scoring query
    where: list[str] = []
    params: dict = {
        "ref_code": saleProdCd or None,
        "ref_cities": ref_cities,
        "theme_key": theme_key or None,
        "q": int(season_quarter) if season_quarter else None,
        "brand": brand or None,
        "alpha": float(alpha),
        "beta": float(beta),
        "gamma": float(gamma),
        "limit": int(limit),
    }

    if saleProdCd:
        where.append("p.saleProdCd <> $ref_code")
    if brand:
        where.append("p.brndNm = $brand")

    where_clause = ("WHERE " + " AND ".join(where)) if where else ""

    query = f"""
    MATCH (p:SaleProduct)
    {where_clause}
    OPTIONAL MATCH (p)-[:VISITS_CITY|ARRIVES_IN]->(pc:City)
    WITH p, collect(DISTINCT pc.name) AS p_cities
    OPTIONAL MATCH (p)-[:HAS_SCHEDULED_ATTRACTION]->(:Attraction)-[t:IN_THEME]->(:Theme {{key: $theme_key}})
    WITH p, p_cities, avg(coalesce(t.weight, 0)) AS theme_score
    OPTIONAL MATCH (p)-[:HAS_SCHEDULED_ATTRACTION]->(:Attraction)-[s:BEST_IN_SEASON]->(:Season {{quarter: $q}})
    WITH p, p_cities, theme_score, avg(coalesce(s.weight, 0)) AS season_score
    RETURN p,
           p_cities,
           coalesce(theme_score, 0) AS theme_score,
           coalesce(season_score, 0) AS season_score
    LIMIT 200
    """

    rows = execute_query(query, params)

    # Compute jaccard + final score in app (Cypher's collection ops are limited)
    ref_set = set(ref_cities)
    candidates = []
    for row in rows:
        p = extract_node(row, "p")
        p_cities = [c for c in (row.get("p_cities") or []) if c]
        p_set = set(p_cities)
        if ref_set or p_set:
            inter = len(ref_set & p_set)
            union = len(ref_set | p_set) or 1
            city_jaccard = inter / union
        else:
            city_jaccard = 0.0

        theme_score = float(row.get("theme_score") or 0)
        season_score = float(row.get("season_score") or 0)

        score = (
            float(alpha) * city_jaccard
            + float(beta) * theme_score
            + float(gamma) * season_score
        )
        if score <= 0 and not (theme_key or season_quarter or saleProdCd):
            continue
        candidates.append(
            {
                "saleProduct": p,
                "score": round(score, 4),
                "breakdown": {
                    "city_jaccard": round(city_jaccard, 3),
                    "theme_score": round(theme_score, 3),
                    "season_score": round(season_score, 3),
                },
            }
        )

    candidates.sort(key=lambda c: c["score"], reverse=True)
    candidates = candidates[: int(limit)]

    result_str = _attach_trace(
        {
            "weights": {"alpha": float(alpha), "beta": float(beta), "gamma": float(gamma)},
            "reference_cities": ref_cities,
            "candidates": candidates,
            "count": len(candidates),
        }
    )
    _cache_set(cache_key, result_str, CACHE_TTL["find_similar_packages"])
    return result_str


# =============================================================================
# 3. recommend_route
# =============================================================================

def recommend_route(
    arrival_city: str,
    nights: int = 0,
    depart_city: str = "",
) -> str:
    """Flight-segment routes + popular hotels for a given arrival city / nights."""
    if not arrival_city:
        return json.dumps({"error": "arrival_city is required"}, ensure_ascii=False)

    cache_key = _make_cache_key(
        "recommend_route",
        arrival_city=arrival_city,
        nights=nights,
        depart_city=depart_city,
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()

    params: dict = {
        "arr": arrival_city,
        "dep": depart_city or None,
        "nights": int(nights) if nights else None,
    }

    route_rows = execute_query(
        "MATCH (p:SaleProduct)-[:ARRIVES_IN]->(c:City) "
        "WHERE c.name = $arr OR c.code = $arr "
        "MATCH (p)-[:HAS_FLIGHT_SEGMENT]->(f:FlightSegment) "
        "WHERE $dep IS NULL OR f.depAirportCode = $dep OR f.depCityName = $dep "
        "RETURN f.depAirportCode AS depAirport, f.depAirportName AS depName, "
        "       f.arrAirportCode AS arrAirport, f.arrAirportName AS arrName, "
        "       f.airlCd AS airline, f.airlNm AS airlineName, "
        "       count(*) AS frequency "
        "ORDER BY frequency DESC LIMIT 30",
        params,
    )

    routes = [
        {
            "depAirport": r.get("depAirport"),
            "depAirportName": r.get("depName"),
            "arrAirport": r.get("arrAirport"),
            "arrAirportName": r.get("arrName"),
            "airline": r.get("airline"),
            "airlineName": r.get("airlineName"),
            "frequency": r.get("frequency"),
        }
        for r in route_rows
    ]

    hotel_rows = []
    if nights:
        hotel_rows = execute_query(
            "MATCH (p:SaleProduct)-[:ARRIVES_IN]->(c:City) "
            "WHERE (c.name = $arr OR c.code = $arr) AND p.trvlNgtCnt = $nights "
            "MATCH (p)-[hs:HAS_HOTEL_STAY]->(s:HotelStay) "
            "OPTIONAL MATCH (s)-[:MATCHED_TO]->(h:Hotel) "
            "RETURN coalesce(h.name, s.locaDesc) AS hotel, "
            "       h.grade AS grade, "
            "       count(*) AS frequency, "
            "       collect(DISTINCT hs.schdDay) AS used_on_days "
            "ORDER BY frequency DESC LIMIT 20",
            params,
        )

    popular_hotels = [
        {
            "hotel": r.get("hotel"),
            "grade": r.get("grade"),
            "frequency": r.get("frequency"),
            "used_on_days": sorted(r.get("used_on_days") or []),
        }
        for r in hotel_rows
        if r.get("hotel")
    ]

    result_str = _attach_trace(
        {
            "arrival_city": arrival_city,
            "nights": nights,
            "depart_city": depart_city,
            "routes": routes,
            "popular_hotels": popular_hotels,
        }
    )
    _cache_set(cache_key, result_str, CACHE_TTL["recommend_route"])
    return result_str


# =============================================================================
# 4. recommend_attractions  ⭐ CORE
# =============================================================================

def recommend_attractions(
    city: str,
    theme_key: str = "",
    season_quarter: int = 0,
    exclude_ids: list | None = None,
    selected_ids: list | None = None,
    mood_keywords: list | None = None,
    arrival_airport_code: str = "",
    alpha: float = 0.40,
    beta: float = 0.25,
    gamma: float = 0.15,
    delta: float = 0.15,
    epsilon: float = 0.05,
    limit: int = 15,
    min_score: float = 0.05,
) -> str:
    """Score-first attraction recommendation.

    score = α * IN_THEME[theme_key].weight
          + β * BEST_IN_SEASON[Q].weight
          + γ * mood_overlap_ratio (mood_keywords vs featureMoodTagsJson + featureExperienceTagsJson)
          + δ * max(TRAVEL_TO[s, a].weight for s in selected_ids)
          + ε * ARRIVAL_FIRST_VISIT[Airport[arrival_airport_code], a].weight
    """
    if not city:
        return json.dumps({"error": "city is required"}, ensure_ascii=False)

    exclude_ids = exclude_ids or []
    selected_ids = selected_ids or []
    mood_keywords = mood_keywords or []

    # Normalize ids for matching against a.id property
    exclude_norm = [_normalize_attraction_id(x) for x in exclude_ids if x]
    selected_norm = [_normalize_attraction_id(x) for x in selected_ids if x]
    mood_upper = [m.upper() for m in mood_keywords if isinstance(m, str)]

    cache_key = _make_cache_key(
        "recommend_attractions",
        city=city,
        theme_key=theme_key,
        season_quarter=season_quarter,
        exclude_ids=exclude_norm,
        selected_ids=selected_norm,
        mood_keywords=mood_upper,
        arrival_airport_code=arrival_airport_code,
        alpha=alpha,
        beta=beta,
        gamma=gamma,
        delta=delta,
        epsilon=epsilon,
        limit=limit,
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()

    params: dict = {
        "city": city,
        "theme_key": theme_key or None,
        "q": int(season_quarter) if season_quarter else None,
        "exclude_ids": exclude_norm or None,
        "selected_ids": selected_norm or None,
        "arr_apt": arrival_airport_code or None,
        "alpha": float(alpha),
        "beta": float(beta),
        "delta": float(delta),
        "epsilon": float(epsilon),
        "min_score": float(min_score),
        "limit_pre": int(limit) * 3,
    }

    # Pre-rank in Cypher (excluding tag overlap which is computed in app).
    query = """
    MATCH (a:Attraction)-[:IN_CITY]->(c:City)
    WHERE (c.name = $city OR c.code = $city)
      AND ($exclude_ids IS NULL OR NOT a.id IN $exclude_ids)
    OPTIONAL MATCH (a)-[t:IN_THEME]->(:Theme {key: $theme_key})
    OPTIONAL MATCH (a)-[s:BEST_IN_SEASON]->(:Season {quarter: $q})
    OPTIONAL MATCH (a)<-[afv:ARRIVAL_FIRST_VISIT]-(:Airport {airportCode: $arr_apt})
    OPTIONAL MATCH (sel:Attraction)-[tt:TRAVEL_TO]->(a)
      WHERE $selected_ids IS NOT NULL AND sel.id IN $selected_ids
    WITH a,
         coalesce(t.weight, 0)            AS theme_w,
         coalesce(t.rationale, '')        AS theme_reason,
         coalesce(s.weight, 0)            AS season_w,
         coalesce(afv.weight, 0)          AS afv_w,
         coalesce(max(tt.weight), 0)      AS travel_to_w
    WITH a, theme_reason, theme_w, season_w, afv_w, travel_to_w,
         ($alpha * theme_w
          + $beta * season_w
          + $epsilon * afv_w
          + $delta * travel_to_w) AS partial_score
    WHERE partial_score >= $min_score OR theme_w > 0 OR season_w > 0
    RETURN a.id AS id,
           a.name AS name,
           a.featureSummaryKo AS summary,
           a.recommendedStayMinutes AS stay_minutes,
           a.minStayMinutes AS min_stay_minutes,
           a.maxStayMinutes AS max_stay_minutes,
           a.type AS type,
           a.lat AS lat, a.lng AS lng,
           a.nightViewFlag AS night_view,
           a.mealFitFlag AS meal_fit,
           a.rainPlanRequired AS rain_sensitive,
           a.rainSuitability AS rain_suitability,
           a.summerHeatSuitability AS summer_suitability,
           a.winterSuitability AS winter_suitability,
           a.featureCostType AS cost_type,
           a.featureActivityLevel AS activity_level,
           a.featureWeatherSensitivity AS weather_sensitivity,
           a.featureIndoorOutdoorType AS indoor_outdoor,
           a.featureMoodTagsJson AS mood_json,
           a.featureExperienceTagsJson AS exp_json,
           a.featureLocationContextTagsJson AS loc_json,
           a.featureAgePreferenceTagsJson AS age_json,
           a.featureBestVisitTimeBandsJson AS time_json,
           a.featureCoVisitTopJson AS covisit_json,
           theme_w, season_w, afv_w, travel_to_w,
           partial_score, theme_reason
    ORDER BY partial_score DESC
    LIMIT $limit_pre
    """
    rows = execute_query(query, params)

    # Application-side: compute tag overlap (mood/experience/location/age) and finalize score
    keyword_set = set(mood_upper)
    keyword_size = len(keyword_set) or 1

    # Build a set of selected_ids (raw) for CoVisit lookup
    selected_set = set(selected_norm)

    items: list[dict] = []
    for r in rows:
        mood_tags = _parse_json_list(r.get("mood_json"))
        exp_tags = _parse_json_list(r.get("exp_json"))
        loc_tags = _parse_json_list(r.get("loc_json"))
        age_tags = _parse_json_list(r.get("age_json"))
        time_bands = _parse_json_list(r.get("time_json"))
        covisit_top = _parse_json_list(r.get("covisit_json"))
        # Tag overlap: mood + experience + location + age 모두 keyword_set 과 매칭
        attr_tag_set = {
            str(x).upper()
            for x in mood_tags + exp_tags + loc_tags + age_tags
        }
        if keyword_set:
            inter = len(keyword_set & attr_tag_set)
            tag_overlap = inter / keyword_size
        else:
            tag_overlap = 0.0

        # CoVisit boost: featureCoVisitTopJson 에 selected_ids 가 있으면 가산
        # featureCoVisitTopJson 형식: ["LJP_xxx", ...] 또는 [{"id":...,"score":...}]
        covisit_boost = 0.0
        if selected_set and covisit_top:
            for item in covisit_top:
                cid = item if isinstance(item, str) else (item.get("id") if isinstance(item, dict) else None)
                if cid and cid in selected_set:
                    covisit_boost = max(
                        covisit_boost,
                        float(item.get("score", 0.5)) if isinstance(item, dict) else 0.5,
                    )

        partial = float(r.get("partial_score") or 0)
        # δ 항을 max(travel_to_w, covisit_boost) 로 강화
        travel_to_w = float(r.get("travel_to_w") or 0)
        effective_travel = max(travel_to_w, covisit_boost)
        # partial_score 는 기존 travel_to_w 만 반영했으므로, covisit 가 더 크면 차이만큼 보정
        partial += float(delta) * (effective_travel - travel_to_w)

        score = partial + float(gamma) * tag_overlap
        if score < float(min_score):
            continue

        items.append(
            {
                "id": r.get("id"),
                "name": r.get("name"),
                "summary": r.get("summary"),
                "stay_minutes": r.get("stay_minutes"),
                "min_stay_minutes": r.get("min_stay_minutes"),
                "max_stay_minutes": r.get("max_stay_minutes"),
                "type": r.get("type"),
                "lat": r.get("lat"),
                "lng": r.get("lng"),
                "score": round(score, 4),
                "breakdown": {
                    "theme": round(float(r.get("theme_w") or 0), 3),
                    "season": round(float(r.get("season_w") or 0), 3),
                    "mood": round(tag_overlap, 3),
                    "travel_to": round(travel_to_w, 3),
                    "covisit": round(covisit_boost, 3),
                    "afv": round(float(r.get("afv_w") or 0), 3),
                },
                "rationale": r.get("theme_reason") or "",
                "flags": {
                    "night_view": bool(r.get("night_view")),
                    "meal_fit": bool(r.get("meal_fit")),
                    "rain_sensitive": bool(r.get("rain_sensitive")),
                },
                "suitability": {
                    "rain": r.get("rain_suitability"),
                    "summer": r.get("summer_suitability"),
                    "winter": r.get("winter_suitability"),
                    "cost_type": r.get("cost_type"),
                    "activity_level": r.get("activity_level"),
                    "weather_sensitivity": r.get("weather_sensitivity"),
                    "indoor_outdoor": r.get("indoor_outdoor"),
                },
                "tags": {
                    "mood": mood_tags,
                    "experience": exp_tags,
                    "location_context": loc_tags,
                    "age_preference": age_tags,
                    "best_visit_time": time_bands,
                },
            }
        )

    items.sort(key=lambda x: x["score"], reverse=True)
    items = items[: int(limit)]

    result_str = _attach_trace(
        {
            "city": city,
            "theme_key": theme_key,
            "season_quarter": season_quarter,
            "weights": {
                "alpha": float(alpha),
                "beta": float(beta),
                "gamma": float(gamma),
                "delta": float(delta),
                "epsilon": float(epsilon),
            },
            "mood_keywords": mood_upper,
            "attractions": items,
            "count": len(items),
        }
    )
    _cache_set(cache_key, result_str, CACHE_TTL["recommend_attractions"])
    return result_str


# =============================================================================
# 5. recommend_hotels
# =============================================================================

def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def recommend_hotels(
    city: str,
    grade: str = "",
    near_attraction_id: str = "",
    alpha: float = 0.7,
    beta: float = 0.3,
    limit: int = 10,
) -> str:
    """Hotel ranking with optional distance-to-attraction score.

    score = α * city_match (binary)
          + β * distance_score (1 if same point, decays with km)
    """
    if not city:
        return json.dumps({"error": "city is required"}, ensure_ascii=False)

    cache_key = _make_cache_key(
        "recommend_hotels",
        city=city,
        grade=grade,
        near_attraction_id=_normalize_attraction_id(near_attraction_id),
        alpha=alpha,
        beta=beta,
        limit=limit,
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()

    where_parts = ["(c.name = $city OR c.code = $city)"]
    params: dict = {"city": city}
    if grade:
        where_parts.append("h.grade = $grade")
        params["grade"] = grade

    rows = execute_query(
        "MATCH (h:Hotel)-[:IN_CITY]->(c:City) "
        "WHERE " + " AND ".join(where_parts) + " "
        "RETURN h.packageHotelId AS id, h.name AS name, h.grade AS grade, "
        "       h.lat AS lat, h.lng AS lng, h.address AS address, "
        "       h.location AS location, h.thumbnail AS thumbnail "
        "LIMIT 300",
        params,
    )

    # Optional: pivot point coords from near_attraction_id
    pivot_lat = pivot_lng = None
    if near_attraction_id:
        norm = _normalize_attraction_id(near_attraction_id)
        attr_rows = execute_query(
            "MATCH (a:Attraction {id: $aid}) RETURN a.lat AS lat, a.lng AS lng",
            {"aid": norm},
        )
        if attr_rows:
            pivot_lat = attr_rows[0].get("lat")
            pivot_lng = attr_rows[0].get("lng")

    hotels: list[dict] = []
    for r in rows:
        lat = r.get("lat")
        lng = r.get("lng")
        distance_km = None
        distance_score = 0.0
        if pivot_lat is not None and pivot_lng is not None and lat is not None and lng is not None:
            try:
                distance_km = _haversine_km(
                    float(pivot_lat), float(pivot_lng), float(lat), float(lng)
                )
                # 0km → 1.0, 5km → ~0.37 (exp decay with k=0.2)
                distance_score = math.exp(-0.2 * distance_km)
            except (TypeError, ValueError):
                pass

        score = float(alpha) * 1.0 + float(beta) * distance_score
        hotel = {
            "id": r.get("id"),
            "name": r.get("name"),
            "grade": r.get("grade"),
            "address": r.get("address"),
            "location": r.get("location"),
            "thumbnail": r.get("thumbnail"),
            "lat": lat,
            "lng": lng,
            "score": round(score, 4),
            "breakdown": {
                "city_match": 1.0,
                "distance_score": round(distance_score, 3),
                "distance_km": round(distance_km, 2) if distance_km is not None else None,
            },
        }
        hotels.append(hotel)

    hotels.sort(key=lambda h: h["score"], reverse=True)
    hotels = hotels[: int(limit)]

    result_str = _attach_trace(
        {
            "city": city,
            "grade": grade,
            "near_attraction_id": near_attraction_id,
            "weights": {"alpha": float(alpha), "beta": float(beta)},
            "hotels": hotels,
            "count": len(hotels),
        }
    )
    _cache_set(cache_key, result_str, CACHE_TTL["recommend_hotels"])
    return result_str


# =============================================================================
# 6. get_attraction_neighbors
# =============================================================================

def get_attraction_neighbors(
    attraction_id: str,
    theme_key: str = "",
    limit: int = 10,
) -> str:
    """Given an attraction, find next-visit neighbors via TRAVEL_TO edges."""
    if not attraction_id:
        return json.dumps({"error": "attraction_id is required"}, ensure_ascii=False)

    norm = _normalize_attraction_id(attraction_id)
    cache_key = _make_cache_key(
        "get_attraction_neighbors", aid=norm, theme_key=theme_key, limit=limit
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()

    rows = execute_query(
        "MATCH (a:Attraction {id: $aid})-[t:TRAVEL_TO]->(next:Attraction) "
        "WHERE t.count >= 1 "
        "OPTIONAL MATCH (next)-[th:IN_THEME]->(:Theme {key: $theme_key}) "
        "RETURN next.id AS id, next.name AS name, "
        "       next.featureSummaryKo AS summary, "
        "       t.count AS count, t.weight AS travel_weight, "
        "       t.avgGapMinutes AS avg_gap, "
        "       coalesce(th.weight, 0) AS theme_match "
        "ORDER BY (coalesce(t.weight, 0) * 0.7 + coalesce(th.weight, 0) * 0.3) DESC "
        "LIMIT $limit",
        {"aid": norm, "theme_key": theme_key or None, "limit": int(limit)},
    )

    neighbors = []
    for r in rows:
        tw = float(r.get("travel_weight") or 0)
        tm = float(r.get("theme_match") or 0)
        score = tw * 0.7 + tm * 0.3
        neighbors.append(
            {
                "id": r.get("id"),
                "name": r.get("name"),
                "summary": r.get("summary"),
                "count": r.get("count"),
                "travel_weight": tw,
                "avg_gap_minutes": r.get("avg_gap"),
                "theme_match": tm,
                "score": round(score, 4),
            }
        )

    result_str = _attach_trace(
        {
            "from_attraction": norm,
            "theme_key": theme_key,
            "neighbors": neighbors,
            "count": len(neighbors),
        }
    )
    _cache_set(cache_key, result_str, CACHE_TTL["get_attraction_neighbors"])
    return result_str


# =============================================================================
# 7. get_attraction_detail
# =============================================================================

def get_attraction_detail(attraction_id: str) -> str:
    """Single attraction detail (all v3 enrichment fields)."""
    if not attraction_id:
        return json.dumps({"error": "attraction_id is required"}, ensure_ascii=False)

    norm = _normalize_attraction_id(attraction_id)
    cache_key = _make_cache_key("get_attraction_detail", aid=norm)
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()
    rows = execute_query(
        "MATCH (a:Attraction {id: $aid}) "
        "OPTIONAL MATCH (a)-[:IN_CITY]->(c:City) "
        "RETURN a, c.name AS cityName, c.code AS cityCode",
        {"aid": norm},
    )
    if not rows:
        result = _attach_trace({"error": f"Attraction '{norm}' not found"})
        _cache_set(cache_key, result, NEGATIVE_TTL)
        return result

    attr = extract_node(rows[0], "a")
    attr["cityName"] = rows[0].get("cityName")
    attr["cityCode"] = rows[0].get("cityCode")
    # Parse JSON fields for convenience
    for k in (
        "featureMoodTagsJson",
        "featureExperienceTagsJson",
        "featureAgePreferenceTagsJson",
        "featureLocationContextTagsJson",
        "featureBestVisitTimeBandsJson",
        "featureCoVisitTopJson",
    ):
        if attr.get(k):
            attr[k] = _parse_json_list(attr[k])

    result_str = _attach_trace({"attraction": attr})
    _cache_set(cache_key, result_str, CACHE_TTL["get_attraction_detail"])
    return result_str


# =============================================================================
# 8. explain_score
# =============================================================================

def explain_score(
    attraction_id: str,
    theme_key: str = "",
    season_quarter: int = 0,
) -> str:
    """Decompose attraction score for debugging / demo."""
    if not attraction_id:
        return json.dumps({"error": "attraction_id is required"}, ensure_ascii=False)

    norm = _normalize_attraction_id(attraction_id)
    cache_key = _make_cache_key(
        "explain_score",
        aid=norm,
        theme_key=theme_key,
        season_quarter=season_quarter,
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()
    rows = execute_query(
        "MATCH (a:Attraction {id: $aid}) "
        "OPTIONAL MATCH (a)-[t:IN_THEME]->(theme:Theme {key: $theme_key}) "
        "OPTIONAL MATCH (a)-[s:BEST_IN_SEASON]->(season:Season {quarter: $q}) "
        "RETURN a.id AS id, a.name AS name, "
        "       a.featureSummaryKo AS summary, a.type AS type, "
        "       a.recommendedStayMinutes AS stay_minutes, "
        "       a.featureMoodTagsJson AS mood_json, "
        "       a.featureExperienceTagsJson AS exp_json, "
        "       coalesce(t.weight, 0) AS theme_w, "
        "       coalesce(t.rationale, '') AS theme_reason, "
        "       coalesce(s.weight, 0) AS season_w, "
        "       theme.key AS theme_key_match, season.quarter AS q_match",
        {"aid": norm, "theme_key": theme_key or None, "q": int(season_quarter) if season_quarter else None},
    )

    if not rows:
        result = _attach_trace({"error": f"Attraction '{norm}' not found"})
        _cache_set(cache_key, result, NEGATIVE_TTL)
        return result

    r = rows[0]
    payload = {
        "attraction_id": r.get("id"),
        "name": r.get("name"),
        "summary": r.get("summary"),
        "type": r.get("type"),
        "stay_minutes": r.get("stay_minutes"),
        "components": {
            "theme": {
                "key": r.get("theme_key_match") or theme_key,
                "weight": r.get("theme_w"),
                "rationale": r.get("theme_reason"),
            },
            "season": {
                "quarter": r.get("q_match") or season_quarter,
                "weight": r.get("season_w"),
            },
            "mood_tags": _parse_json_list(r.get("mood_json")),
            "experience_tags": _parse_json_list(r.get("exp_json")),
        },
    }
    result_str = _attach_trace(payload)
    _cache_set(cache_key, result_str, CACHE_TTL["explain_score"])
    return result_str


# =============================================================================
# 8b. validate_city_scope
# =============================================================================

def validate_city_scope(
    day_attractions: dict,
    day_cities: dict,
) -> str:
    """Verify each day's attractions belong to that day's cities.

    Args:
        day_attractions: ``{"1": ["기요미즈데라", ...], "2": [...]}`` — names per day.
        day_cities:      ``{"1": ["오사카","교토"], "2": ["교토"]}`` — allowed cities per day.

    Returns JSON: ``{"issues": [{"day", "name", "actual_cities", "reason"}], "missing": [...]}``
    """
    if not isinstance(day_attractions, dict) or not isinstance(day_cities, dict):
        return json.dumps(
            {"error": "day_attractions/day_cities must be dicts"},
            ensure_ascii=False,
        )

    # Collect every distinct attraction name across days
    all_names: set[str] = set()
    parsed_attrs: dict[int, list[str]] = {}
    parsed_cities: dict[int, set[str]] = {}
    for k, v in day_attractions.items():
        try:
            d = int(k)
        except (TypeError, ValueError):
            continue
        if isinstance(v, list):
            names = [str(n) for n in v if n]
            parsed_attrs[d] = names
            all_names.update(names)
    for k, v in day_cities.items():
        try:
            d = int(k)
        except (TypeError, ValueError):
            continue
        if isinstance(v, list):
            parsed_cities[d] = {str(c).strip() for c in v if c}
        elif isinstance(v, str):
            parsed_cities[d] = {c.strip() for c in v.split(",") if c.strip()}

    if not all_names:
        return _attach_trace({"issues": [], "missing": []})

    reset_trace()
    rows = execute_query(
        "MATCH (a:Attraction)-[:IN_CITY]->(c:City) "
        "WHERE a.name IN $names "
        "RETURN a.name AS name, collect(DISTINCT c.name) AS cities",
        {"names": sorted(all_names)},
    )
    name_to_cities: dict[str, set[str]] = {}
    for r in rows:
        name = r.get("name")
        cs = {c for c in (r.get("cities") or []) if c}
        if name:
            name_to_cities[name] = cs

    issues: list[dict] = []
    missing: list[dict] = []
    for day_num, names in parsed_attrs.items():
        allowed = parsed_cities.get(day_num, set())
        if not allowed:
            continue
        for name in names:
            actual = name_to_cities.get(name)
            if actual is None:
                missing.append({"day": day_num, "name": name})
                continue
            if not (actual & allowed):
                issues.append(
                    {
                        "day": day_num,
                        "name": name,
                        "actual_cities": sorted(actual),
                        "expected_cities": sorted(allowed),
                    }
                )

    return _attach_trace({"issues": issues, "missing": missing})


# =============================================================================
# 9. plan_context_bundle
# =============================================================================

def plan_context_bundle(
    arrival_city: str,
    nights: int = 0,
    saleProdCd: str = "",
    theme_key: str = "",
    season_quarter: int = 0,
    brand: str = "",
    depart_city: str = "",
) -> str:
    """All Skeleton-stage context in one MCP call.

    Wraps:
      - get_reference_package (if saleProdCd)
      - find_similar_packages (if any of saleProdCd/theme_key/season_quarter)
      - recommend_route (always)
    """
    if not arrival_city:
        return json.dumps({"error": "arrival_city is required"}, ensure_ascii=False)

    cache_key = _make_cache_key(
        "plan_context_bundle",
        arrival_city=arrival_city,
        nights=nights,
        saleProdCd=saleProdCd,
        theme_key=theme_key,
        season_quarter=season_quarter,
        brand=brand,
        depart_city=depart_city,
    )
    cached = _cache_get(cache_key)
    if cached is not None:
        return _cached_with_trace(cached)

    reset_trace()  # bundle owns its own trace; sub-calls use the same buffer

    bundle: dict[str, Any] = {
        "arrival_city": arrival_city,
        "nights": nights,
        "saleProdCd": saleProdCd,
        "theme_key": theme_key,
        "season_quarter": season_quarter,
        "brand": brand,
    }

    # 1. Reference package (only if requested)
    if saleProdCd:
        ref_str = get_reference_package(saleProdCd=saleProdCd)
        try:
            ref_data = json.loads(ref_str)
            ref_data.pop("_trace", None)
            bundle["reference"] = ref_data
        except (ValueError, TypeError):
            bundle["reference"] = None

    # 2. Similar packages (if any signal)
    if saleProdCd or theme_key or season_quarter:
        sim_str = find_similar_packages(
            saleProdCd=saleProdCd,
            theme_key=theme_key,
            season_quarter=season_quarter,
            brand=brand,
            limit=10,
        )
        try:
            sim_data = json.loads(sim_str)
            sim_data.pop("_trace", None)
            bundle["similar"] = sim_data
        except (ValueError, TypeError):
            bundle["similar"] = None

    # 3. Theme metadata (calibration anchor)
    if theme_key:
        try:
            theme_rows = execute_query(
                "MATCH (t:Theme {key: $key}) "
                "RETURN t.key AS key, t.ko AS ko, t.kind AS kind, "
                "       t.description AS description, "
                "       t.highExample AS high_example, "
                "       t.lowExample AS low_example, "
                "       t.displayOrder AS display_order",
                {"key": theme_key},
            )
            if theme_rows:
                bundle["theme_meta"] = theme_rows[0]
        except Exception:  # noqa: BLE001
            pass

    # 4. Season metadata
    if season_quarter:
        try:
            season_rows = execute_query(
                "MATCH (s:Season {quarter: $q}) "
                "RETURN s.key AS key, s.quarter AS quarter, s.name AS name, "
                "       s.nameEn AS name_en, s.monthsJson AS months_json, "
                "       s.climateSummary AS climate",
                {"q": int(season_quarter)},
            )
            if season_rows:
                row = season_rows[0]
                row["months"] = _parse_json_list(row.pop("months_json", None))
                bundle["season_meta"] = row
        except Exception:  # noqa: BLE001
            pass

    # 5. Routes & popular hotels (always)
    route_str = recommend_route(
        arrival_city=arrival_city,
        nights=nights,
        depart_city=depart_city,
    )
    try:
        route_data = json.loads(route_str)
        route_data.pop("_trace", None)
        bundle["route"] = route_data
    except (ValueError, TypeError):
        bundle["route"] = None

    # Note: each sub-call internally calls reset_trace() so the final get_trace()
    # only contains the LAST sub-call's queries. To preserve full trace, we
    # accumulate manually instead of calling reset_trace inside sub-tools — but
    # since this is a one-time bundle invocation, we accept this limitation
    # for now. The Lambda layer trace already captures everything per-call;
    # the agent-side _safe_call wrapper will record this.
    result_str = _attach_trace(bundle)
    _cache_set(cache_key, result_str, CACHE_TTL["plan_context_bundle"])
    return result_str


# =============================================================================
# 10. invalidate_cache
# =============================================================================

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
