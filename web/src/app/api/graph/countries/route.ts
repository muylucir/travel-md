import { NextResponse } from "next/server";
import { getTraversal } from "@/lib/gremlin";
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
    const g = await getTraversal();
    const results = await g.V().hasLabel("Country").values("name").toList();
    const countries = (results as string[]).sort();
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
