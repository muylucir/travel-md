import { NextResponse } from "next/server";
import { executeQuery } from "@/lib/neptune";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";

const CACHE_KEY = "countries";

/**
 * GET /api/graph/countries
 * Returns all Country nodes from Neptune. Cached for 1h.
 */
export async function GET() {
  const cached = cacheGet<string[]>(CACHE_KEY);
  if (cached) return NextResponse.json(cached);

  try {
    const results = await executeQuery<{ name: string }>(
      "MATCH (c:Country) RETURN c.name AS name ORDER BY c.name"
    );
    const countries = results.map((r) => r.name);
    cacheSet(CACHE_KEY, countries, TTL.STATIC);
    return NextResponse.json(countries);
  } catch (error) {
    console.error("[/api/graph/countries] Error:", error);
    return NextResponse.json(
      { error: "국가 목록 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
