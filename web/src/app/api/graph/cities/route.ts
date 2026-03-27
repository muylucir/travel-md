import { NextRequest, NextResponse } from "next/server";
import { executeQuery, extractNode } from "@/lib/neptune";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";
import type { CityNode } from "@/lib/types";

/**
 * GET /api/graph/cities
 * List cities, with optional region filter. Cached for 1h.
 *
 * Query params:
 *   region  - filter by region (e.g., "규슈", "오사카")
 *   country - filter by country (e.g., "일본", "태국")
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const region = searchParams.get("region");
  const country = searchParams.get("country");

  const cacheKey = `cities:${region || ""}:${country || ""}`;
  const cached = cacheGet<CityNode[]>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const params: Record<string, unknown> = {};
    let whereClause = "";

    if (country) {
      whereClause = " WHERE c.country = $country";
      params.country = country;
    } else if (region) {
      whereClause = " WHERE c.region = $region";
      params.region = region;
    }

    const results = await executeQuery(
      `MATCH (c:City)${whereClause} RETURN c ORDER BY c.name`,
      Object.keys(params).length > 0 ? params : undefined
    );

    const cities: CityNode[] = results.map((row) => {
      const obj = extractNode(row as Record<string, unknown>, "c");
      return {
        name: String(obj.name || ""),
        country: String(obj.country || ""),
        region: String(obj.region || ""),
        code: obj.code as string | undefined,
        timezone: obj.timezone as string | undefined,
        voltage: obj.voltage as string | undefined,
        size: obj.size as string | undefined,
      };
    });

    cacheSet(cacheKey, cities, TTL.STATIC);
    return NextResponse.json(cities);
  } catch (error) {
    console.error("[/api/graph/cities] Error:", error);
    return NextResponse.json(
      { error: "도시 목록 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
