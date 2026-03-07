import { NextRequest, NextResponse } from "next/server";
import gremlin from "gremlin";
import { getTraversal, mapToObject } from "@/lib/gremlin";
import type { CityNode } from "@/lib/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asc = (gremlin.process as any).order.asc;

/**
 * GET /api/graph/cities
 * List cities, with optional region filter.
 *
 * Query params:
 *   region  - filter by region (e.g., "규슈", "오사카")
 *   country - filter by country (e.g., "일본", "태국")
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const region = searchParams.get("region");
    const country = searchParams.get("country");

    const g = await getTraversal();
    let traversal = g.V().hasLabel("City");

    if (country) {
      traversal = traversal.has("country", country);
    } else if (region) {
      traversal = traversal.has("region", region);
    }

    const results = await traversal
      .order()
      .by("name", asc)
      .valueMap(true)
      .toList();

    const cities: CityNode[] = results.map((r: unknown) => {
      const obj = mapToObject<Record<string, unknown>>(r as Map<string, unknown>);
      return {
        name: extractValue(obj, "name") as string,
        country: extractValue(obj, "country") as string,
        region: extractValue(obj, "region") as string,
        code: extractValue(obj, "code") as string | undefined,
        timezone: extractValue(obj, "timezone") as string | undefined,
        voltage: extractValue(obj, "voltage") as string | undefined,
        size: extractValue(obj, "size") as string | undefined,
      };
    });

    return NextResponse.json(cities);
  } catch (error) {
    console.error("[/api/graph/cities] Error:", error);
    return NextResponse.json(
      { error: "도시 목록 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

function extractValue(
  obj: Record<string, unknown>,
  key: string
): unknown {
  const v = obj[key];
  return Array.isArray(v) ? v[0] : v;
}
