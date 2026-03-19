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

    // Drop all edges first, then all vertices
    // Neptune handles large deletes in batches internally
    await g.E().drop().iterate();
    await g.V().drop().iterate();

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
