"""Tool: get_package -- v3 SaleProduct + related entities."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query, extract_node

logger = logging.getLogger(__name__)


@tool
def get_package(saleProdCd: str) -> str:
    """Retrieve full SaleProduct info: arrival/visit cities, scheduled attractions,
    hotel stays (with matched Hotel master), flight segments, brand,
    and representative product.

    Args:
        saleProdCd: The SaleProduct code (e.g. 'JKP130260401TWX').
    """
    if not saleProdCd:
        return json.dumps({"error": "saleProdCd is required"}, ensure_ascii=False)

    params = {"code": saleProdCd}

    pkg_rows = execute_query(
        "MATCH (p:SaleProduct {saleProdCd: $code}) RETURN p", params
    )
    if not pkg_rows:
        return json.dumps({"error": f"SaleProduct '{saleProdCd}' not found"}, ensure_ascii=False)
    package = extract_node(pkg_rows[0], "p")

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
    return json.dumps(result, ensure_ascii=False, default=str)
