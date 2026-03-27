import { NextRequest, NextResponse } from "next/server";
import { executeQuery, extractNode, toGraphNode } from "@/lib/neptune";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";
import { valkeyGet, valkeySet, ValkeyTTL } from "@/lib/valkey";
import type { GraphData } from "@/lib/types";

/**
 * GET /api/graph/visualize
 * Full knowledge graph visualization data.
 * Two-tier cache: L1 in-memory (10min) → L2 Valkey (1h) → Neptune.
 *
 * Query params:
 *   types - comma-separated node type filter (e.g., "Package,City")
 *   limit - max nodes to return (default 200, 0 = unlimited)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const typesParam = searchParams.get("types");
    const types = typesParam
      ? typesParam.split(",").map((t) => t.trim()).filter(Boolean)
      : [];
    const limitParam = searchParams.get("limit");
    const nodeLimit = limitParam !== null ? parseInt(limitParam, 10) : 200;

    // --- L1: in-memory cache ---
    const cacheKey = `graph:${types.join(",") || "all"}:${nodeLimit}`;
    const l1 = cacheGet<GraphData>(cacheKey);
    if (l1) return NextResponse.json(l1);

    // --- L2: Valkey cache ---
    const l2 = await valkeyGet<GraphData>(cacheKey);
    if (l2) {
      cacheSet(cacheKey, l2, TTL.STATIC);
      return NextResponse.json(l2);
    }

    // 1. Fetch vertices
    let vertexQuery = "MATCH (n)";
    const params: Record<string, unknown> = {};
    if (types.length > 0) {
      // Validate labels (alphanumeric + underscore only)
      const safeTypes = types.filter((t) => /^[A-Za-z0-9_]+$/.test(t));
      if (safeTypes.length > 0) {
        vertexQuery += ` WHERE labels(n)[0] IN $types`;
        params.types = safeTypes;
      }
    }
    vertexQuery += " RETURN n, id(n) AS nodeId";
    if (nodeLimit > 0) {
      vertexQuery += ` LIMIT ${nodeLimit}`;
    }

    const vertexRows = await executeQuery(vertexQuery, params);

    const nodes = vertexRows.map((row) => {
      const r = row as Record<string, unknown>;
      const props = extractNode(r, "n");
      // Ensure id from the query result
      if (!props.id && r.nodeId) props.id = r.nodeId;
      return toGraphNode(props);
    });

    // Build set of valid node IDs for edge filtering
    const nodeIdSet = new Set(nodes.map((n) => n.id));
    const nodeIds = Array.from(nodeIdSet);

    // 2. Fetch edges between these vertices
    let edges: Array<{ id: string; source: string; target: string; label: string }> = [];
    if (nodeIds.length > 0) {
      const edgeRows = await executeQuery(
        "MATCH (a)-[r]->(b) " +
        "WHERE id(a) IN $ids AND id(b) IN $ids " +
        "RETURN DISTINCT id(r) AS eid, type(r) AS label, " +
        "id(startNode(r)) AS source, id(endNode(r)) AS target",
        { ids: nodeIds }
      );

      for (const row of edgeRows) {
        const r = row as Record<string, unknown>;
        const edgeId = String(r.eid ?? "");
        const edgeLabel = String(r.label ?? "");
        const source = String(r.source ?? "");
        const target = String(r.target ?? "");

        if (source && target && nodeIdSet.has(source) && nodeIdSet.has(target)) {
          edges.push({ id: edgeId, source, target, label: edgeLabel });
        }
      }
    }

    // Deduplicate edges
    const edgeMap = new Map<string, (typeof edges)[0]>();
    for (const e of edges) {
      const key = `${e.source}-${e.label}-${e.target}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, e);
      }
    }
    edges = Array.from(edgeMap.values());

    // 3. Compute stats
    const stats: Record<string, number> = {};
    for (const n of nodes) {
      stats[n.type] = (stats[n.type] || 0) + 1;
    }

    const result: GraphData = { nodes, links: edges, stats };

    // Store in both tiers
    cacheSet(cacheKey, result, TTL.STATIC);
    valkeySet(cacheKey, result, ValkeyTTL.GRAPH_STATIC);

    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/graph/visualize] Error:", error);
    return NextResponse.json(
      { error: "그래프 데이터 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
