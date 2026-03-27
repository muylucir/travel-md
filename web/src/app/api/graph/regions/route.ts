import { NextResponse } from "next/server";
import { executeQuery, extractNode } from "@/lib/neptune";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";

const CACHE_KEY = "regions";

/**
 * GET /api/graph/regions
 * Returns all Region nodes from Neptune. Cached for 1h.
 */
export async function GET() {
  const cached = cacheGet<Array<{ name: string }>>(CACHE_KEY);
  if (cached) return NextResponse.json(cached);

  try {
    const results = await executeQuery(
      "MATCH (r:Region) RETURN r"
    );

    const regions = results.map((row) => {
      const obj = extractNode(row as Record<string, unknown>, "r");
      return {
        name: String(obj.name || ""),
      };
    });

    cacheSet(CACHE_KEY, regions, TTL.STATIC);
    return NextResponse.json(regions);
  } catch (error) {
    console.error("[/api/graph/regions] Error:", error);
    return NextResponse.json(
      { error: "지역 목록 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
