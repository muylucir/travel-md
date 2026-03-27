import { NextRequest, NextResponse } from "next/server";
import { executeQuery, extractNode } from "@/lib/neptune";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";

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

    const cacheKey = `pkg-detail:${code}`;
    const cached = cacheGet<Record<string, unknown>>(cacheKey);
    if (cached) return NextResponse.json(cached);

    // Fetch package node
    const packageResults = await executeQuery(
      "MATCH (p:Package {code: $code}) RETURN p",
      { code }
    );

    if (packageResults.length === 0) {
      return NextResponse.json(
        { error: `패키지 '${code}'를 찾을 수 없습니다.` },
        { status: 404 }
      );
    }

    const pkg = extractNode(packageResults[0] as Record<string, unknown>, "p");

    // Fetch related cities
    const cityResults = await executeQuery(
      "MATCH (:Package {code: $code})-[:VISITS]->(c:City) RETURN DISTINCT c",
      { code }
    );
    const cities = cityResults.map((row) =>
      extractNode(row as Record<string, unknown>, "c")
    );

    // Fetch related attractions
    const attractionResults = await executeQuery(
      "MATCH (:Package {code: $code})-[:INCLUDES]->(a:Attraction) RETURN DISTINCT a",
      { code }
    );
    const attractions = attractionResults.map((row) =>
      extractNode(row as Record<string, unknown>, "a")
    );

    // Fetch related hotels
    const hotelResults = await executeQuery(
      "MATCH (:Package {code: $code})-[:INCLUDES_HOTEL|STAYS_AT]->(h:Hotel) RETURN DISTINCT h",
      { code }
    );
    const hotels = hotelResults.map((row) =>
      extractNode(row as Record<string, unknown>, "h")
    );

    // Fetch related routes (flights)
    const routeResults = await executeQuery(
      "MATCH (:Package {code: $code})-[:DEPARTS_ON]->(r:Route) RETURN DISTINCT r",
      { code }
    );
    const routes = routeResults.map((row) =>
      extractNode(row as Record<string, unknown>, "r")
    );

    // Fetch themes
    const themeResults = await executeQuery(
      "MATCH (:Package {code: $code})-[:TAGGED|HAS_THEME]->(t:Theme) RETURN DISTINCT t",
      { code }
    );
    const themes = themeResults.map((row) =>
      extractNode(row as Record<string, unknown>, "t")
    );

    const result = { package: pkg, cities, attractions, hotels, routes, themes };
    cacheSet(cacheKey, result, TTL.SEMI_STATIC);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/packages/[code]] Error:", error);
    return NextResponse.json(
      { error: "패키지 상세 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
