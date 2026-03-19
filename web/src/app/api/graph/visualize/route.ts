import { NextRequest, NextResponse } from "next/server";
import { getTraversal, mapToObject } from "@/lib/gremlin";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";
import { valkeyGet, valkeySet, ValkeyTTL } from "@/lib/valkey";
import gremlin from "gremlin";
import type { GraphData } from "@/lib/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const __ = gremlin.process.statics as any;

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

    const g = await getTraversal();

    // 1. Fetch vertices
    let vertexTraversal = g.V();
    if (types.length > 0) {
      vertexTraversal = vertexTraversal.hasLabel(...types);
    }

    if (nodeLimit > 0) {
      vertexTraversal = vertexTraversal.limit(nodeLimit);
    }
    const vertices = await vertexTraversal.valueMap(true).toList();

    const nodes = vertices.map((v: unknown) => {
      const obj = mapToObject<Record<string, unknown>>(
        v as Map<string, unknown>
      );
      const id = String(obj.id ?? obj["T.id"] ?? "");
      const label = extractValue(obj, "name") ?? extractValue(obj, "code") ?? id;
      const type = String(obj.label ?? obj["T.label"] ?? "unknown");

      const properties: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj)) {
        if (key !== "id" && key !== "label" && key !== "T.id" && key !== "T.label") {
          properties[key] = Array.isArray(val) && val.length === 1 ? val[0] : val;
        }
      }

      return { id, label: String(label), type, properties };
    });

    // Build set of valid node IDs for edge filtering
    const nodeIdSet = new Set(nodes.map((n: { id: string }) => n.id));
    const nodeIds = Array.from(nodeIdSet);

    // 2. Fetch edges between these vertices using project() for reliable extraction
    let edges: Array<{ id: string; source: string; target: string; label: string }> = [];
    if (nodeIds.length > 0) {
      const batchSize = 200;
      for (let i = 0; i < nodeIds.length; i += batchSize) {
        const batch = nodeIds.slice(i, i + batchSize);
        const edgeResults = await g
          .V(...batch)
          .bothE()
          .where(__.otherV().hasId(...nodeIds))
          .dedup()
          .project("id", "label", "source", "target")
          .by(__.id())
          .by(__.label())
          .by(__.outV().id())
          .by(__.inV().id())
          .toList();

        for (const e of edgeResults) {
          const obj = mapToObject<Record<string, unknown>>(
            e as Map<string, unknown>
          );
          const edgeId = String(obj.id ?? "");
          const edgeLabel = String(obj.label ?? "");
          const source = String(obj.source ?? "");
          const target = String(obj.target ?? "");

          if (source && target && nodeIdSet.has(source) && nodeIdSet.has(target)) {
            edges.push({ id: edgeId, source, target, label: edgeLabel });
          }
        }
      }
    }

    // Deduplicate edges
    const edgeMap = new Map<string, typeof edges[0]>();
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

function extractValue(
  obj: Record<string, unknown>,
  key: string
): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  return String(Array.isArray(v) ? v[0] : v);
}
