import { NextRequest, NextResponse } from "next/server";
import { executeQuery, extractNode } from "@/lib/neptune";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";
import type { AttractionNode } from "@/lib/types";

/**
 * GET /api/graph/attractions
 * List attractions by city.
 *
 * Query params:
 *   city     - city name (required)
 *   category - optional category filter
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const city = searchParams.get("city");
    const category = searchParams.get("category");

    if (!city) {
      return NextResponse.json(
        { error: "city 파라미터가 필요합니다." },
        { status: 400 }
      );
    }

    const cacheKey = `attractions:${city}:${category || ""}`;
    const cached = cacheGet<AttractionNode[]>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const params: Record<string, unknown> = { city };
    let categoryFilter = "";

    if (category) {
      categoryFilter = " AND a.category = $category";
      params.category = category;
    }

    const results = await executeQuery(
      `MATCH (:City {name: $city})-[:HAS_ATTRACTION]->(a:Attraction) WHERE true${categoryFilter} RETURN DISTINCT a`,
      params
    );

    const attractions: AttractionNode[] = results.map((row) => {
      const obj = extractNode(row as Record<string, unknown>, "a");
      return {
        name: String(obj.name || ""),
        category: String(obj.category || ""),
        description: obj.description as string | undefined,
        family_friendly: Boolean(obj.family_friendly),
        photo_worthy: Boolean(obj.photo_worthy),
      };
    });

    cacheSet(cacheKey, attractions, TTL.STATIC);
    return NextResponse.json(attractions);
  } catch (error) {
    console.error("[/api/graph/attractions] Error:", error);
    return NextResponse.json(
      { error: "관광지 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
