import { NextResponse } from "next/server";
import { getTraversal } from "@/lib/gremlin";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";
import { valkeyGet, valkeySet, ValkeyTTL } from "@/lib/valkey";

interface GraphStats {
  nodeCountByType: Record<string, number>;
  edgeCountByLabel: Record<string, number>;
  totalNodes: number;
  totalEdges: number;
}

/**
 * GET /api/graph/stats
 * Lightweight stats-only endpoint — no node/edge data returned.
 * Two-tier cache: L1 in-memory (10min) → L2 Valkey (30min) → Neptune.
 */
export async function GET() {
  try {
    const cacheKey = "graph:stats";

    const l1 = cacheGet<GraphStats>(cacheKey);
    if (l1) return NextResponse.json(l1);

    const l2 = await valkeyGet<GraphStats>(cacheKey);
    if (l2) {
      cacheSet(cacheKey, l2, TTL.STATIC);
      return NextResponse.json(l2);
    }

    const g = await getTraversal();

    // Node counts by label
    const nodeCounts = await g.V().groupCount().by("~label").next();
    const nodeCountByType: Record<string, number> = {};
    let totalNodes = 0;
    if (nodeCounts.value instanceof Map) {
      for (const [label, count] of nodeCounts.value) {
        const c = Number(count);
        nodeCountByType[String(label)] = c;
        totalNodes += c;
      }
    }

    // Edge counts by label
    const edgeCounts = await g.E().groupCount().by("~label").next();
    const edgeCountByLabel: Record<string, number> = {};
    let totalEdges = 0;
    if (edgeCounts.value instanceof Map) {
      for (const [label, count] of edgeCounts.value) {
        const c = Number(count);
        edgeCountByLabel[String(label)] = c;
        totalEdges += c;
      }
    }

    const result: GraphStats = {
      nodeCountByType,
      edgeCountByLabel,
      totalNodes,
      totalEdges,
    };

    cacheSet(cacheKey, result, TTL.STATIC);
    valkeySet(cacheKey, result, ValkeyTTL.GRAPH_STATIC);

    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/graph/stats] Error:", error);
    return NextResponse.json(
      { error: "그래프 통계 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
