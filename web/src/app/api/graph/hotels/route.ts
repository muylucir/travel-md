import { NextRequest, NextResponse } from "next/server";
import { executeQuery, extractNode } from "@/lib/neptune";
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

    const params: Record<string, unknown> = { city };
    const filters: string[] = [];

    if (grade) {
      filters.push("h.grade = $grade");
      params.grade = grade;
    }

    if (hasOnsen === "true") {
      filters.push("h.has_onsen = true");
    }

    const whereClause = filters.length > 0
      ? ` WHERE ${filters.join(" AND ")}`
      : "";

    const results = await executeQuery(
      `MATCH (:City {name: $city})-[:HAS_HOTEL]->(h:Hotel)${whereClause} RETURN DISTINCT h`,
      params
    );

    const hotels: HotelNode[] = results.map((row) => {
      const obj = extractNode(row as Record<string, unknown>, "h");
      return {
        name_ko: String(obj.name_ko || ""),
        name_en: String(obj.name_en || ""),
        grade: String(obj.grade || ""),
        room_type: obj.room_type as string | undefined,
        has_onsen: Boolean(obj.has_onsen),
        amenities: obj.amenities as string | undefined,
        description: obj.description as string | undefined,
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
