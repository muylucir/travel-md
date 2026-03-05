import { NextRequest, NextResponse } from "next/server";
import { getTraversal, mapToObject } from "@/lib/gremlin";

/**
 * GET /api/packages/[code]
 * Get a single package by code, including related entities
 * (cities, attractions, hotels, routes, themes).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    const g = await getTraversal();

    // Fetch package node
    const packageResults = await g
      .V()
      .hasLabel("Package")
      .has("code", code)
      .valueMap(true)
      .toList();

    if (packageResults.length === 0) {
      return NextResponse.json(
        { error: `패키지 '${code}'를 찾을 수 없습니다.` },
        { status: 404 }
      );
    }

    const pkg = mapToObject<Record<string, unknown>>(
      packageResults[0] as Map<string, unknown>
    );

    // Fetch related cities
    const cityResults = await g
      .V()
      .hasLabel("Package")
      .has("code", code)
      .out("VISITS")
      .hasLabel("City")
      .dedup()
      .valueMap(true)
      .toList();

    const cities = cityResults.map((r: unknown) =>
      mapToObject(r as Map<string, unknown>)
    );

    // Fetch related attractions
    const attractionResults = await g
      .V()
      .hasLabel("Package")
      .has("code", code)
      .out("INCLUDES")
      .hasLabel("Attraction")
      .dedup()
      .valueMap(true)
      .toList();

    const attractions = attractionResults.map((r: unknown) =>
      mapToObject(r as Map<string, unknown>)
    );

    // Fetch related hotels
    const hotelResults = await g
      .V()
      .hasLabel("Package")
      .has("code", code)
      .out("INCLUDES_HOTEL", "STAYS_AT")
      .hasLabel("Hotel")
      .dedup()
      .valueMap(true)
      .toList();

    const hotels = hotelResults.map((r: unknown) =>
      mapToObject(r as Map<string, unknown>)
    );

    // Fetch related routes (flights)
    const routeResults = await g
      .V()
      .hasLabel("Package")
      .has("code", code)
      .out("DEPARTS_ON")
      .hasLabel("Route")
      .dedup()
      .valueMap(true)
      .toList();

    const routes = routeResults.map((r: unknown) =>
      mapToObject(r as Map<string, unknown>)
    );

    // Fetch themes
    const themeResults = await g
      .V()
      .hasLabel("Package")
      .has("code", code)
      .out("TAGGED", "HAS_THEME")
      .hasLabel("Theme")
      .dedup()
      .valueMap(true)
      .toList();

    const themes = themeResults.map((r: unknown) =>
      mapToObject(r as Map<string, unknown>)
    );

    return NextResponse.json({
      package: pkg,
      cities,
      attractions,
      hotels,
      routes,
      themes,
    });
  } catch (error) {
    console.error("[/api/packages/[code]] Error:", error);
    return NextResponse.json(
      { error: "패키지 상세 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
