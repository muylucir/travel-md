import { NextRequest, NextResponse } from "next/server";
import { executeQuery, extractNode, toGraphNode } from "@/lib/neptune";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";
import { valkeyGet, valkeySet, ValkeyTTL } from "@/lib/valkey";
import type { GraphData } from "@/lib/types";

/**
 * GET /api/graph/visualize/neighbors
 * 1-hop neighbor expansion for any vertex.
 * Two-tier cache: L1 in-memory (30min) → L2 Valkey (30min) → Neptune.
 *
 * Query params:
 *   id - Neptune vertex ID (required)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { error: "정점 ID(id)가 필요합니다." },
        { status: 400 }
      );
    }

    // --- L1: in-memory cache ---
    const cacheKey = `neighbors:${id}`;
    const l1 = cacheGet<GraphData>(cacheKey);
    if (l1) return NextResponse.json(l1);

    // --- L2: Valkey cache ---
    const l2 = await valkeyGet<GraphData>(cacheKey);
    if (l2) {
      cacheSet(cacheKey, l2, TTL.SEMI_STATIC);
      return NextResponse.json(l2);
    }

    // 1. Get the source vertex by ID
    const sourceRows = await executeQuery(
      "MATCH (n) WHERE id(n) = $nodeId RETURN n",
      { nodeId: id }
    );

    if (sourceRows.length === 0) {
      return NextResponse.json(
        { error: `정점 '${id}'를 찾을 수 없습니다.` },
        { status: 404 }
      );
    }

    const sourceProps = extractNode(sourceRows[0] as Record<string, unknown>, "n");
    if (!sourceProps.id) sourceProps.id = id;
    const sourceNode = toGraphNode(sourceProps);

    // 2. Get 1-hop neighbors (both directions)
    const neighborRows = await executeQuery(
      "MATCH (n)--(m) WHERE id(n) = $nodeId RETURN DISTINCT m, id(m) AS nodeId",
      { nodeId: id }
    );

    const neighborNodes = neighborRows.map((row) => {
      const r = row as Record<string, unknown>;
      const props = extractNode(r, "m");
      if (!props.id && r.nodeId) props.id = r.nodeId;
      return toGraphNode(props);
    });

    const allNodes = [sourceNode, ...neighborNodes];
    const nodeIdSet = new Set(allNodes.map((n) => n.id));

    // 3. Get edges from/to the source vertex
    const edgeRows = await executeQuery(
      "MATCH (n)-[r]-(m) WHERE id(n) = $nodeId " +
      "RETURN DISTINCT id(r) AS eid, type(r) AS label, " +
      "id(startNode(r)) AS source, id(endNode(r)) AS target",
      { nodeId: id }
    );

    const links: Array<{ id: string; source: string; target: string; label: string }> = [];
    for (const row of edgeRows) {
      const r = row as Record<string, unknown>;
      const edgeId = String(r.eid ?? "");
      const edgeLabel = String(r.label ?? "");
      const source = String(r.source ?? "");
      const target = String(r.target ?? "");

      if (source && target && nodeIdSet.has(source) && nodeIdSet.has(target)) {
        links.push({ id: edgeId, source, target, label: edgeLabel });
      }
    }

    // 4. Stats
    const stats: Record<string, number> = {};
    for (const n of allNodes) {
      stats[n.type] = (stats[n.type] || 0) + 1;
    }

    const result: GraphData = { nodes: allNodes, links, stats };

    // Store in both tiers
    cacheSet(cacheKey, result, TTL.SEMI_STATIC);
    valkeySet(cacheKey, result, ValkeyTTL.GRAPH_SEMI);

    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/graph/visualize/neighbors] Error:", error);
    return NextResponse.json(
      { error: "이웃 노드 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
