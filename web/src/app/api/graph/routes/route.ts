import { NextRequest, NextResponse } from "next/server";
import { executeQuery, extractNode } from "@/lib/neptune";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";
import type { RouteNode } from "@/lib/types";

/**
 * GET /api/graph/routes
 * List flight routes, optionally filtered by region.
 *
 * Query params:
 *   region - filter routes to/from cities in this region
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const region = searchParams.get("region");

    const cacheKey = `routes:${region || ""}`;
    const cached = cacheGet<RouteNode[]>(cacheKey);
    if (cached) return NextResponse.json(cached);

    let query: string;
    let params: Record<string, unknown> | undefined;

    if (region) {
      query = "MATCH (r:Route)-[:TO]->(c:City {region: $region}) RETURN DISTINCT r";
      params = { region };
    } else {
      query = "MATCH (r:Route) RETURN r";
    }

    const results = await executeQuery(query, params);

    const routes: RouteNode[] = results.map((row) => {
      const obj = extractNode(row as Record<string, unknown>, "r");
      return {
        id: String(obj.id || ""),
        departure_city: String(obj.departure_city || ""),
        arrival_city: String(obj.arrival_city || ""),
        airline: String(obj.airline || ""),
        airline_type: String(obj.airline_type || ""),
        flight_number: String(obj.flight_number || ""),
        departure_time: String(obj.departure_time || ""),
        arrival_time: String(obj.arrival_time || ""),
        duration: String(obj.duration || ""),
      };
    });

    cacheSet(cacheKey, routes, TTL.STATIC);
    return NextResponse.json(routes);
  } catch (error) {
    console.error("[/api/graph/routes] Error:", error);
    return NextResponse.json(
      { error: "항공 노선 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
