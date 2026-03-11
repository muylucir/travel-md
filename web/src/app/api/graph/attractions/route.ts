import { NextRequest, NextResponse } from "next/server";
import { getTraversal, mapToObject } from "@/lib/gremlin";
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

    const g = await getTraversal();
    let traversal = g
      .V()
      .hasLabel("City")
      .has("name", city)
      .out("HAS_ATTRACTION")
      .hasLabel("Attraction");

    if (category) {
      traversal = traversal.has("category", category);
    }

    const results = await traversal
      .dedup()
      .valueMap(true)
      .toList();

    const attractions: AttractionNode[] = results.map((r: unknown) => {
      const obj = mapToObject<Record<string, unknown>>(r as Map<string, unknown>);
      const val = (key: string) => {
        const v = obj[key];
        return Array.isArray(v) ? v[0] : v;
      };
      return {
        name: String(val("name") || ""),
        category: String(val("category") || ""),
        description: val("description") as string | undefined,
        family_friendly: Boolean(val("family_friendly")),
        photo_worthy: Boolean(val("photo_worthy")),
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
