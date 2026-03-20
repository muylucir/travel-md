import { NextResponse } from "next/server";
import gremlin from "gremlin";
import { getTraversal, mapToObject } from "@/lib/gremlin";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";
import { valkeyGet, valkeySet, ValkeyTTL } from "@/lib/valkey";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T = (gremlin.process as any).t;

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

    // Node counts by label (T.label for Neptune Gremlin)
    const nodeCounts = await g.V().groupCount().by(T.label).next();
    const nodeCountByType: Record<string, number> = {};
    let totalNodes = 0;
    const nodeMap =
      nodeCounts.value instanceof Map
        ? nodeCounts.value
        : new Map(Object.entries(mapToObject<Record<string, unknown>>(nodeCounts.value)));
    for (const [label, count] of nodeMap) {
      const c = Number(count);
      nodeCountByType[String(label)] = c;
      totalNodes += c;
    }

    // Edge counts by label
    const edgeCounts = await g.E().groupCount().by(T.label).next();
    const edgeCountByLabel: Record<string, number> = {};
    let totalEdges = 0;
    const edgeMap =
      edgeCounts.value instanceof Map
        ? edgeCounts.value
        : new Map(Object.entries(mapToObject<Record<string, unknown>>(edgeCounts.value)));
    for (const [label, count] of edgeMap) {
      const c = Number(count);
      edgeCountByLabel[String(label)] = c;
      totalEdges += c;
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
