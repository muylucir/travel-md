import { NextRequest, NextResponse } from "next/server";
import { getTraversal, mapToObject } from "@/lib/gremlin";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";
import { valkeyGet, valkeySet, ValkeyTTL } from "@/lib/valkey";
import gremlin from "gremlin";
import type { GraphData } from "@/lib/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const __ = gremlin.process.statics as any;

/**
 * GET /api/graph/visualize/package
 * Package-centric 1-hop star subgraph.
 * Two-tier cache: L1 in-memory (30min) → L2 Valkey (30min) → Neptune.
 *
 * Query params:
 *   code - package code (required, e.g., "AVP231260401OZC")
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");

    if (!code) {
      return NextResponse.json(
        { error: "패키지 코드(code)가 필요합니다." },
        { status: 400 }
      );
    }

    // --- L1: in-memory cache ---
    const cacheKey = `pkg-graph:${code}`;
    const l1 = cacheGet<GraphData>(cacheKey);
    if (l1) return NextResponse.json(l1);

    // --- L2: Valkey cache ---
    const l2 = await valkeyGet<GraphData>(cacheKey);
    if (l2) {
      cacheSet(cacheKey, l2, TTL.SEMI_STATIC);
      return NextResponse.json(l2);
    }

    const g = await getTraversal();

    // 1. Find the package vertex
    const pkgResults = await g
      .V()
      .hasLabel("Package")
      .has("code", code)
      .valueMap(true)
      .toList();

    if (pkgResults.length === 0) {
      return NextResponse.json(
        { error: `패키지 '${code}'를 찾을 수 없습니다.` },
        { status: 404 }
      );
    }

    const pkgObj = mapToObject<Record<string, unknown>>(
      pkgResults[0] as Map<string, unknown>
    );
    const pkgId = String(pkgObj.id ?? pkgObj["T.id"] ?? "");
    const pkgNode = toGraphNode(pkgObj, pkgId);

    // 2. Get 1-hop neighbors (both directions)
    const neighborResults = await g
      .V(pkgId)
      .both()
      .dedup()
      .valueMap(true)
      .toList();

    const neighborNodes = neighborResults.map((r: unknown) => {
      const obj = mapToObject<Record<string, unknown>>(
        r as Map<string, unknown>
      );
      const id = String(obj.id ?? obj["T.id"] ?? "");
      return toGraphNode(obj, id);
    });

    const allNodes = [pkgNode, ...neighborNodes];
    const nodeIdSet = new Set(allNodes.map((n) => n.id));

    // 3. Get edges from the package vertex using project() for reliable extraction
    const edgeResults = await g
      .V(pkgId)
      .bothE()
      .dedup()
      .project("id", "label", "source", "target")
      .by(__.id())
      .by(__.label())
      .by(__.outV().id())
      .by(__.inV().id())
      .toList();

    const links: Array<{ id: string; source: string; target: string; label: string }> = [];
    for (const e of edgeResults) {
      const obj = mapToObject<Record<string, unknown>>(
        e as Map<string, unknown>
      );
      const edgeId = String(obj.id ?? "");
      const edgeLabel = String(obj.label ?? "");
      const source = String(obj.source ?? "");
      const target = String(obj.target ?? "");

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
    console.error("[/api/graph/visualize/package] Error:", error);
    return NextResponse.json(
      { error: "패키지 서브그래프 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

function toGraphNode(obj: Record<string, unknown>, id: string) {
  const label =
    extractValue(obj, "name") ?? extractValue(obj, "code") ?? id;
  const type = String(obj.label ?? obj["T.label"] ?? "unknown");

  const properties: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key !== "id" && key !== "label" && key !== "T.id" && key !== "T.label") {
      properties[key] = Array.isArray(val) && val.length === 1 ? val[0] : val;
    }
  }

  return { id, label: String(label), type, properties };
}

function extractValue(
  obj: Record<string, unknown>,
  key: string
): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  return String(Array.isArray(v) ? v[0] : v);
}
