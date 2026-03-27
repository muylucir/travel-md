import { NextResponse } from "next/server";
import { executeQuery } from "@/lib/neptune";
import { cacheInvalidate } from "@/lib/api-cache";

/**
 * DELETE /api/graph/data
 * Drop all vertices and edges from Neptune graph DB.
 * Requires confirmation header: X-Confirm-Delete: DELETE_ALL_GRAPH_DATA
 */
export async function DELETE(request: Request) {
  try {
    const confirmation = request.headers.get("X-Confirm-Delete");
    if (confirmation !== "DELETE_ALL_GRAPH_DATA") {
      return NextResponse.json(
        { error: "확인 헤더가 필요합니다: X-Confirm-Delete: DELETE_ALL_GRAPH_DATA" },
        { status: 400 }
      );
    }

    // Count before deletion
    const [nodeResult] = await executeQuery<{ cnt: number }>(
      "MATCH (n) RETURN count(n) AS cnt"
    );
    const [edgeResult] = await executeQuery<{ cnt: number }>(
      "MATCH ()-[r]->() RETURN count(r) AS cnt"
    );
    const beforeNodes = Number(nodeResult?.cnt ?? 0);
    const beforeEdges = Number(edgeResult?.cnt ?? 0);

    const BATCH = 500;

    // Drop edges in batches
    let hasMore = true;
    while (hasMore) {
      await executeQuery(
        `MATCH ()-[r]->() WITH r LIMIT ${BATCH} DELETE r`
      );
      const [rem] = await executeQuery<{ cnt: number }>(
        "MATCH ()-[r]->() RETURN count(r) AS cnt"
      );
      hasMore = Number(rem?.cnt ?? 0) > 0;
    }

    // Drop vertices in batches
    hasMore = true;
    while (hasMore) {
      await executeQuery(
        `MATCH (n) WITH n LIMIT ${BATCH} DETACH DELETE n`
      );
      const [rem] = await executeQuery<{ cnt: number }>(
        "MATCH (n) RETURN count(n) AS cnt"
      );
      hasMore = Number(rem?.cnt ?? 0) > 0;
    }

    // Invalidate all graph caches
    cacheInvalidate("graph:");
    cacheInvalidate("packages:");
    cacheInvalidate("trends:");

    return NextResponse.json({
      success: true,
      deleted: {
        nodes: beforeNodes,
        edges: beforeEdges,
      },
    });
  } catch (error) {
    console.error("[/api/graph/data] DELETE Error:", error);
    return NextResponse.json(
      { error: `그래프 삭제 중 오류: ${error instanceof Error ? error.message : "알 수 없는 오류"}` },
      { status: 500 }
    );
  }
}
