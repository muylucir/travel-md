import { NextRequest, NextResponse } from "next/server";
import { executeQuery } from "@/lib/neptune";

interface PropertyMapping {
  jsonField: string;
  nodeProperty: string;
  include: boolean;
}

interface NodeDesignConfig {
  nodeLabel: string;
  idField: string;
  propertyMappings: PropertyMapping[];
}

interface EdgeMappingRule {
  sourceField: string;
  targetNodeLabel: string;
  targetMatchProperty: string;
  edgeLabel: string;
  direction: "out" | "in";
  autoCreateTarget: boolean;
}

type DuplicateStrategy = "skip" | "update" | "create";

interface UploadRequest {
  data: Record<string, unknown>[];
  nodeDesign: NodeDesignConfig;
  edgeMappings: EdgeMappingRule[];
  duplicateStrategy: DuplicateStrategy;
}

/**
 * POST /api/graph/upload
 * Bulk upload nodes and edges to Neptune graph DB using OpenCypher.
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const result = {
    nodesCreated: 0,
    nodesSkipped: 0,
    nodesUpdated: 0,
    edgesCreated: 0,
    edgesSkipped: 0,
    targetNodesCreated: 0,
    errors: [] as string[],
    durationMs: 0,
  };

  try {
    const body: UploadRequest = await request.json();
    const { data, nodeDesign, edgeMappings, duplicateStrategy } = body;

    if (!data || !Array.isArray(data) || data.length === 0) {
      return NextResponse.json(
        { error: "데이터가 비어있습니다." },
        { status: 400 }
      );
    }

    // Validate label (prevent injection since labels can't be parameterized)
    if (!/^[A-Za-z0-9_]+$/.test(nodeDesign.nodeLabel)) {
      return NextResponse.json(
        { error: "유효하지 않은 노드 라벨입니다." },
        { status: 400 }
      );
    }

    // Cache for target vertex lookups: "Label:value" → vertexId
    const targetCache = new Map<string, string | null>();

    for (let i = 0; i < data.length; i++) {
      const item = data[i];

      try {
        // 1. Build vertex ID and properties
        const idValue = String(item[nodeDesign.idField] || "");
        if (!idValue) {
          result.errors.push(
            `행 ${i + 1}: ID 필드 "${nodeDesign.idField}"이 비어있습니다.`
          );
          continue;
        }

        const vertexId = `${nodeDesign.nodeLabel}:${idValue}`;

        // 2. Check existence
        const [existsRow] = await executeQuery<{ exists: boolean }>(
          "MATCH (n) WHERE id(n) = $vertexId RETURN count(n) > 0 AS exists",
          { vertexId }
        );
        const exists = existsRow?.exists ?? false;

        if (exists && duplicateStrategy === "skip") {
          result.nodesSkipped++;
          await processEdges(vertexId, item, edgeMappings, targetCache, result);
          continue;
        }

        // 3. Build property SET clause
        const props: Record<string, unknown> = {};
        for (const mapping of nodeDesign.propertyMappings) {
          if (!mapping.include) continue;
          const value = item[mapping.jsonField];
          if (value === null || value === undefined) continue;
          props[mapping.nodeProperty] =
            typeof value === "object" ? JSON.stringify(value) : value;
        }

        // 4. Create or update vertex
        if (exists && duplicateStrategy === "update") {
          // Build SET clauses dynamically
          const setClauses = Object.keys(props)
            .map((k) => `n.\`${k}\` = $props.\`${k}\``)
            .join(", ");
          if (setClauses) {
            await executeQuery(
              `MATCH (n) WHERE id(n) = $vertexId SET ${setClauses}`,
              { vertexId, props }
            );
          }
          result.nodesUpdated++;
        } else {
          // Create new vertex with custom ID using MERGE
          const setClauses = Object.keys(props)
            .map((k) => `n.\`${k}\` = $props.\`${k}\``)
            .join(", ");
          const setStr = setClauses ? `SET ${setClauses}` : "";
          await executeQuery(
            `CREATE (n:${nodeDesign.nodeLabel} {\`~id\`: $vertexId}) ${setStr}`,
            { vertexId, props }
          );
          result.nodesCreated++;
        }

        // 5. Process edge mappings
        await processEdges(vertexId, item, edgeMappings, targetCache, result);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "알 수 없는 오류";
        result.errors.push(`행 ${i + 1}: ${msg}`);
        if (result.errors.length > 100) {
          result.errors.push("... 오류가 너무 많아 중단합니다.");
          break;
        }
      }
    }

    result.durationMs = Date.now() - startTime;
    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/graph/upload] Error:", error);
    result.durationMs = Date.now() - startTime;
    result.errors.push(
      `시스템 오류: ${error instanceof Error ? error.message : "알 수 없는 오류"}`
    );
    return NextResponse.json(result, { status: 500 });
  }
}

async function processEdges(
  sourceVertexId: string,
  item: Record<string, unknown>,
  edgeMappings: EdgeMappingRule[],
  targetCache: Map<string, string | null>,
  result: {
    edgesCreated: number;
    edgesSkipped: number;
    targetNodesCreated: number;
    errors: string[];
  }
) {
  for (const rule of edgeMappings) {
    try {
      // Validate edge label
      if (!/^[A-Za-z0-9_]+$/.test(rule.edgeLabel)) continue;
      if (!/^[A-Za-z0-9_]+$/.test(rule.targetNodeLabel)) continue;

      const rawValue = item[rule.sourceField];
      if (rawValue === null || rawValue === undefined || rawValue === "")
        continue;

      const values = Array.isArray(rawValue)
        ? rawValue.map(String)
        : [String(rawValue)];

      for (const value of values) {
        if (!value) continue;

        const cacheKey = `${rule.targetNodeLabel}:${value}`;
        let targetId = targetCache.get(cacheKey);

        // Look up target if not cached
        if (targetId === undefined) {
          const targets = await executeQuery<{ tid: string }>(
            `MATCH (t:${rule.targetNodeLabel}) WHERE t.\`${rule.targetMatchProperty}\` = $value RETURN id(t) AS tid`,
            { value }
          );

          if (targets.length > 0) {
            targetId = String(targets[0].tid);
          } else if (rule.autoCreateTarget) {
            const newTargetId = cacheKey;
            await executeQuery(
              `CREATE (t:${rule.targetNodeLabel} {\`~id\`: $tid, \`${rule.targetMatchProperty}\`: $value})`,
              { tid: newTargetId, value }
            );
            targetId = newTargetId;
            result.targetNodesCreated++;
          } else {
            targetId = null;
          }
          targetCache.set(cacheKey, targetId ?? null);
        }

        if (!targetId) {
          result.edgesSkipped++;
          continue;
        }

        // Check if edge already exists
        const [edgeCheck] = await executeQuery<{ exists: boolean }>(
          rule.direction === "out"
            ? `MATCH (a)-[r:${rule.edgeLabel}]->(b) WHERE id(a) = $src AND id(b) = $tgt RETURN count(r) > 0 AS exists`
            : `MATCH (a)-[r:${rule.edgeLabel}]->(b) WHERE id(a) = $tgt AND id(b) = $src RETURN count(r) > 0 AS exists`,
          { src: sourceVertexId, tgt: targetId }
        );

        if (edgeCheck?.exists) {
          result.edgesSkipped++;
          continue;
        }

        // Create edge
        await executeQuery(
          rule.direction === "out"
            ? `MATCH (a), (b) WHERE id(a) = $src AND id(b) = $tgt CREATE (a)-[:${rule.edgeLabel}]->(b)`
            : `MATCH (a), (b) WHERE id(a) = $tgt AND id(b) = $src CREATE (a)-[:${rule.edgeLabel}]->(b)`,
          { src: sourceVertexId, tgt: targetId }
        );
        result.edgesCreated++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "엣지 생성 오류";
      result.errors.push(
        `엣지 ${rule.edgeLabel} (${rule.sourceField}=${item[rule.sourceField]}): ${msg}`
      );
    }
  }
}
