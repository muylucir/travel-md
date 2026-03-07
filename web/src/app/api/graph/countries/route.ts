import { NextResponse } from "next/server";
import { getTraversal } from "@/lib/gremlin";

/**
 * GET /api/graph/countries
 * Returns all Country nodes from Neptune.
 */
export async function GET() {
  try {
    const g = await getTraversal();
    const results = await g.V().hasLabel("Country").values("name").toList();
    const countries = (results as string[]).sort();
    return NextResponse.json(countries);
  } catch (error) {
    console.error("[/api/graph/countries] Error:", error);
    return NextResponse.json(
      { error: "국가 목록 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
