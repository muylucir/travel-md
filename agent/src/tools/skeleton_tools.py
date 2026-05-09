"""Skeleton-phase Strands @tool wrappers (mirror of Lambda graph_tools).

Each tool here is a thin wrapper around the corresponding Lambda function
description so the Strands LLM can call it via MCP. Logic lives in Lambda.
"""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query, extract_node

logger = logging.getLogger(__name__)


@tool
def get_reference_package(saleProdCd: str) -> str:
    """기준 SaleProduct 의 풀 디테일 (도시·관광지·호텔stay·항공구간·브랜드).

    기획 입력에 reference_product_id 가 있으면 첫 번째로 호출하세요.
    응답에는 scheduledAttractions[](schdDay 포함), hotelStays[], flightSegments[]
    가 모두 들어 있어 5-Layer 유지 강제 + 일정 보강에 활용됩니다.

    Args:
        saleProdCd: SaleProduct 코드 (예: 'JOP140260329KEH').
    """
    if not saleProdCd:
        return json.dumps({"error": "saleProdCd is required"}, ensure_ascii=False)

    params = {"code": saleProdCd}
    pkg_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code}) RETURN p", params
    )
    if not pkg_rows:
        return json.dumps(
            {"error": f"SaleProduct '{saleProdCd}' not found"}, ensure_ascii=False
        )
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
        "RETURN a, r.schdDay AS schdDay, r.schtExprSqc AS schtExprSqc "
        "ORDER BY r.schdDay, r.schtExprSqc",
        params,
    )
    scheduled_attractions = []
    for row in attr_rows:
        ad = extract_node(row, "a")
        ad["schdDay"] = row.get("schdDay")
        ad["schtExprSqc"] = row.get("schtExprSqc")
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

    return json.dumps(
        {
            "saleProduct": package,
            "arrivalCity": arrival_city,
            "visitCities": visit_cities,
            "scheduledAttractions": scheduled_attractions,
            "hotelStays": hotel_stays,
            "flightSegments": flight_segments,
            "brand": brand,
            "representative": representative,
        },
        ensure_ascii=False,
        default=str,
    )


@tool
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
    """5-Layer 점수 기반 자매 SaleProduct 검색.

    score = α * city_jaccard(p, ref) + β * avg(IN_THEME[theme_key].weight)
          + γ * avg(BEST_IN_SEASON[Q].weight)

    Args:
        saleProdCd: 기준 상품 코드 (있으면 도시 Jaccard 계산).
        theme_key: v3 Theme.key (예: FAMILY_WITH_KIDS).
        season_quarter: Season.quarter 1..4.
        brand: 세이브 또는 스탠다드.
        alpha: 도시 Jaccard 가중 (기본 0.5).
        beta: 테마 가중 (기본 0.3).
        gamma: 시즌 가중 (기본 0.2).
        limit: 기본 10.
    """
    # Resolve reference cities first
    ref_cities: list[str] = []
    if saleProdCd:
        rows = execute_query(
            "MATCH (p:SaleProduct {saleProdCd: $code}) "
            "OPTIONAL MATCH (p)-[:VISITS_CITY|ARRIVES_IN]->(c:City) "
            "RETURN collect(DISTINCT c.name) AS cities",
            {"code": saleProdCd},
        )
        if rows:
            ref_cities = [c for c in (rows[0].get("cities") or []) if c]

    where = []
    params: dict = {
        "ref_code": saleProdCd or None,
        "theme_key": theme_key or None,
        "q": int(season_quarter) if season_quarter else None,
        "brand": brand or None,
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
    RETURN p, p_cities,
           coalesce(theme_score, 0) AS theme_score,
           coalesce(season_score, 0) AS season_score
    LIMIT 200
    """
    rows = execute_query(query, params)

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

    return json.dumps(
        {
            "weights": {"alpha": float(alpha), "beta": float(beta), "gamma": float(gamma)},
            "reference_cities": ref_cities,
            "candidates": candidates,
            "count": len(candidates),
        },
        ensure_ascii=False,
        default=str,
    )


@tool
def recommend_route(arrival_city: str, nights: int = 0, depart_city: str = "") -> str:
    """도착 도시 + 박수 기준 항공 구간 후보 + 자주 쓰이는 호텔 분포.

    Args:
        arrival_city: 도착 도시 이름 또는 코드.
        nights: 박수.
        depart_city: 출발 공항 코드 (예: ICN). 비우면 전체.
    """
    if not arrival_city:
        return json.dumps({"error": "arrival_city is required"}, ensure_ascii=False)

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

    popular_hotels = []
    if nights:
        hotel_rows = execute_query(
            "MATCH (p:SaleProduct)-[:ARRIVES_IN]->(c:City) "
            "WHERE (c.name = $arr OR c.code = $arr) AND p.trvlNgtCnt = $nights "
            "MATCH (p)-[hs:HAS_HOTEL_STAY]->(s:HotelStay) "
            "OPTIONAL MATCH (s)-[:MATCHED_TO]->(h:Hotel) "
            "RETURN coalesce(h.name, s.locaDesc) AS hotel, h.grade AS grade, "
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

    return json.dumps(
        {
            "arrival_city": arrival_city,
            "nights": nights,
            "depart_city": depart_city,
            "routes": routes,
            "popular_hotels": popular_hotels,
        },
        ensure_ascii=False,
        default=str,
    )
