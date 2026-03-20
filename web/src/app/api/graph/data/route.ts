import { NextResponse } from "next/server";
import { getTraversal } from "@/lib/gremlin";
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

    const g = await getTraversal();

    // Count before deletion
    const nodeCount = await g.V().count().next();
    const edgeCount = await g.E().count().next();
    const beforeNodes = Number(nodeCount.value);
    const beforeEdges = Number(edgeCount.value);

    // Neptune doesn't support iterate() (discard operator).
    // Delete in batches using limit + drop + next loop.
    const BATCH = 500;

    // Drop edges in batches
    let hasMore = true;
    while (hasMore) {
      await g.E().limit(BATCH).drop().fold().next();
      const remaining = await g.E().limit(1).count().next();
      hasMore = Number(remaining.value) > 0;
    }

    // Drop vertices in batches
    hasMore = true;
    while (hasMore) {
      await g.V().limit(BATCH).drop().fold().next();
      const remaining = await g.V().limit(1).count().next();
      hasMore = Number(remaining.value) > 0;
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
