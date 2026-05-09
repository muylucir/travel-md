"""Tool: get_routes_by_region -- v3 flight segments by arrival city."""

from __future__ import annotations

import json
import logging

from strands import tool

from src.tools.graph_client import execute_query

logger = logging.getLogger(__name__)


@tool
def get_routes_by_region(arrival_city: str) -> str:
    """Retrieve distinct flight routes (dep airport -> arr airport) that
    arrive at the given city.

    v3 has no Route label; we expose distinct (FlightSegment) pairs for
    SaleProducts whose ARRIVES_IN city matches.

    Args:
        arrival_city: City name or code (e.g. '오사카', 'OSA').
    """
    rows = execute_query(
        "MATCH (p:SaleProduct)-[:ARRIVES_IN]->(c:City) "
        "WHERE c.name = $t OR c.code = $t "
        "MATCH (p)-[:HAS_FLIGHT_SEGMENT]->(f:FlightSegment) "
        "RETURN DISTINCT f.depAirportCode AS depAirport, f.depAirportName AS depAirportName, "
        "       f.arrAirportCode AS arrAirport, f.arrAirportName AS arrAirportName, "
        "       f.airlCd AS airlineCode, f.airlNm AS airlineName, f.segReq AS segReq",
        {"t": arrival_city},
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
    return json.dumps(
        {"routes": routes, "count": len(routes)}, ensure_ascii=False, default=str
    )
