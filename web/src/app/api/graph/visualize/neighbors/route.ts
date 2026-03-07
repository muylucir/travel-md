import { NextRequest, NextResponse } from "next/server";
import { getTraversal, mapToObject } from "@/lib/gremlin";

/**
 * GET /api/graph/visualize/neighbors
 * 1-hop neighbor expansion for any vertex.
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

    const g = await getTraversal();

    // 1. Get the source vertex by ID
    const sourceResults = await g.V(id).valueMap(true).toList();

    if (sourceResults.length === 0) {
      return NextResponse.json(
        { error: `정점 '${id}'를 찾을 수 없습니다.` },
        { status: 404 }
      );
    }

    const sourceObj = mapToObject<Record<string, unknown>>(
      sourceResults[0] as Map<string, unknown>
    );
    const sourceId = String(sourceObj.id ?? sourceObj["T.id"] ?? "");
    const sourceNode = toGraphNode(sourceObj, sourceId);

    // 2. Get 1-hop neighbors (both directions)
    const neighborResults = await g
      .V(id)
      .both()
      .dedup()
      .valueMap(true)
      .toList();

    const neighborNodes = neighborResults.map((r: unknown) => {
      const obj = mapToObject<Record<string, unknown>>(
        r as Map<string, unknown>
      );
      const nid = String(obj.id ?? obj["T.id"] ?? "");
      return toGraphNode(obj, nid);
    });

    const allNodes = [sourceNode, ...neighborNodes];
    const nodeIdSet = new Set(allNodes.map((n) => n.id));

    // 3. Get edges from/to the source vertex
    const edgeResults = await g.V(id).bothE().dedup().toList();

    const links: Array<{ id: string; source: string; target: string; label: string }> = [];
    for (const e of edgeResults) {
      const obj = mapToObject<Record<string, unknown>>(
        e as Map<string, unknown>
      );
      const edgeId = String(obj.id ?? obj["T.id"] ?? "");
      const edgeLabel = String(obj.label ?? obj["T.label"] ?? "");

      let source = "";
      let target = "";
      if (obj.outV && typeof obj.outV === "object") {
        const outObj = obj.outV as Record<string, unknown>;
        source = String(outObj.id ?? outObj["T.id"] ?? "");
      }
      if (obj.inV && typeof obj.inV === "object") {
        const inObj = obj.inV as Record<string, unknown>;
        target = String(inObj.id ?? inObj["T.id"] ?? "");
      }

      if (source && target && nodeIdSet.has(source) && nodeIdSet.has(target)) {
        links.push({ id: edgeId, source, target, label: edgeLabel });
      }
    }

    // 4. Stats
    const stats: Record<string, number> = {};
    for (const n of allNodes) {
      stats[n.type] = (stats[n.type] || 0) + 1;
    }

    return NextResponse.json({ nodes: allNodes, links, stats });
  } catch (error) {
    console.error("[/api/graph/visualize/neighbors] Error:", error);
    return NextResponse.json(
      { error: "이웃 노드 조회 중 오류가 발생했습니다." },
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
