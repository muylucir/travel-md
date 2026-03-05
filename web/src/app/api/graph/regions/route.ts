import { NextResponse } from "next/server";
import { getTraversal, mapToObject } from "@/lib/gremlin";

/**
 * GET /api/graph/regions
 * Returns all Region nodes from Neptune.
 */
export async function GET() {
  try {
    const g = await getTraversal();

    const results = await g
      .V()
      .hasLabel("Region")
      .valueMap(true)
      .toList();

    const regions = results.map((r: unknown) => {
      const obj = mapToObject<Record<string, unknown>>(
        r as Map<string, unknown>
      );
      const val = (key: string): unknown => {
        const v = obj[key];
        return Array.isArray(v) ? v[0] : v;
      };
      return {
        name: String(val("name") || ""),
      };
    });

    return NextResponse.json(regions);
  } catch (error) {
    console.error("[/api/graph/regions] Error:", error);
    return NextResponse.json(
      { error: "지역 목록 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
