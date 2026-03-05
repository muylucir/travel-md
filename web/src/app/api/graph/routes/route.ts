import { NextRequest, NextResponse } from "next/server";
import { getTraversal, mapToObject } from "@/lib/gremlin";
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

    const g = await getTraversal();

    let traversal;
    if (region) {
      // Find routes that connect to cities in the given region
      traversal = g
        .V()
        .hasLabel("City")
        .has("region", region)
        .inE("TO")
        .outV()
        .hasLabel("Route")
        .dedup();
    } else {
      traversal = g.V().hasLabel("Route");
    }

    const results = await traversal.valueMap(true).toList();

    const routes: RouteNode[] = results.map((r: unknown) => {
      const obj = mapToObject<Record<string, unknown>>(r as Map<string, unknown>);
      const val = (key: string) => {
        const v = obj[key];
        return Array.isArray(v) ? v[0] : v;
      };
      return {
        id: String(val("id") || ""),
        departure_city: String(val("departure_city") || ""),
        arrival_city: String(val("arrival_city") || ""),
        airline: String(val("airline") || ""),
        airline_type: String(val("airline_type") || ""),
        flight_number: String(val("flight_number") || ""),
        departure_time: String(val("departure_time") || ""),
        arrival_time: String(val("arrival_time") || ""),
        duration: String(val("duration") || ""),
      };
    });

    return NextResponse.json(routes);
  } catch (error) {
    console.error("[/api/graph/routes] Error:", error);
    return NextResponse.json(
      { error: "항공 노선 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
