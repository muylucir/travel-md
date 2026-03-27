import { NextRequest, NextResponse } from "next/server";
import { executeQuery } from "@/lib/neptune";

/**
 * POST /api/graph/upload/check-duplicates
 * Check which vertex IDs already exist in Neptune.
 *
 * Body: { nodeLabel: string, values: string[] }
 * Returns: { existingValues: string[] }
 */
export async function POST(request: NextRequest) {
  try {
    const { nodeLabel, values } = (await request.json()) as {
      nodeLabel: string;
      values: string[];
    };

    if (!nodeLabel || !values || values.length === 0) {
      return NextResponse.json({ existingValues: [] });
    }

    const existingValues: string[] = [];

    // Check in batches of 100
    const batchSize = 100;
    for (let i = 0; i < values.length; i += batchSize) {
      const batch = values.slice(i, i + batchSize);
      const vertexIds = batch.map((v) => `${nodeLabel}:${v}`);

      const results = await executeQuery<{ nodeId: string }>(
        "MATCH (n) WHERE id(n) IN $ids RETURN id(n) AS nodeId",
        { ids: vertexIds }
      );

      const prefix = `${nodeLabel}:`;
      for (const row of results) {
        const idStr = String(row.nodeId);
        if (idStr.startsWith(prefix)) {
          existingValues.push(idStr.slice(prefix.length));
        }
      }
    }

    return NextResponse.json({ existingValues });
  } catch (error) {
    console.error("[/api/graph/upload/check-duplicates] Error:", error);
    return NextResponse.json(
      { error: "중복 검사 중 오류가 발생했습니다.", existingValues: [] },
      { status: 500 }
    );
  }
}
