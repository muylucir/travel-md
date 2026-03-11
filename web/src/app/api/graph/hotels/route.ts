import { NextRequest, NextResponse } from "next/server";
import { getTraversal, mapToObject } from "@/lib/gremlin";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";
import type { HotelNode } from "@/lib/types";

/**
 * GET /api/graph/hotels
 * List hotels by city.
 *
 * Query params:
 *   city      - city name (required)
 *   grade     - hotel grade filter
 *   has_onsen - filter for onsen hotels ("true"/"false")
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const city = searchParams.get("city");
    const grade = searchParams.get("grade");
    const hasOnsen = searchParams.get("has_onsen");

    if (!city) {
      return NextResponse.json(
        { error: "city 파라미터가 필요합니다." },
        { status: 400 }
      );
    }

    const cacheKey = `hotels:${city}:${grade || ""}:${hasOnsen || ""}`;
    const cached = cacheGet<HotelNode[]>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const g = await getTraversal();
    let traversal = g
      .V()
      .hasLabel("City")
      .has("name", city)
      .out("HAS_HOTEL")
      .hasLabel("Hotel");

    if (grade) {
      traversal = traversal.has("grade", grade);
    }

    if (hasOnsen === "true") {
      traversal = traversal.has("has_onsen", true);
    }

    const results = await traversal
      .dedup()
      .valueMap(true)
      .toList();

    const hotels: HotelNode[] = results.map((r: unknown) => {
      const obj = mapToObject<Record<string, unknown>>(r as Map<string, unknown>);
      const val = (key: string) => {
        const v = obj[key];
        return Array.isArray(v) ? v[0] : v;
      };
      return {
        name_ko: String(val("name_ko") || ""),
        name_en: String(val("name_en") || ""),
        grade: String(val("grade") || ""),
        room_type: val("room_type") as string | undefined,
        has_onsen: Boolean(val("has_onsen")),
        amenities: val("amenities") as string | undefined,
        description: val("description") as string | undefined,
      };
    });

    cacheSet(cacheKey, hotels, TTL.STATIC);
    return NextResponse.json(hotels);
  } catch (error) {
    console.error("[/api/graph/hotels] Error:", error);
    return NextResponse.json(
      { error: "호텔 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
