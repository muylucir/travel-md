import { NextResponse } from "next/server";
import { executeQuery } from "@/lib/neptune";
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

    // Node counts by label
    const nodeRows = await executeQuery<{ label: string; cnt: number }>(
      "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS cnt"
    );
    const nodeCountByType: Record<string, number> = {};
    let totalNodes = 0;
    for (const row of nodeRows) {
      const c = Number(row.cnt);
      nodeCountByType[String(row.label)] = c;
      totalNodes += c;
    }

    // Edge counts by label
    const edgeRows = await executeQuery<{ label: string; cnt: number }>(
      "MATCH ()-[r]->() RETURN type(r) AS label, count(r) AS cnt"
    );
    const edgeCountByLabel: Record<string, number> = {};
    let totalEdges = 0;
    for (const row of edgeRows) {
      const c = Number(row.cnt);
      edgeCountByLabel[String(row.label)] = c;
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
