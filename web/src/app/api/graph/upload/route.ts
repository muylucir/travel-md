import { NextRequest, NextResponse } from "next/server";
import gremlin from "gremlin";
import { getTraversal } from "@/lib/gremlin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { t: T, cardinality } = gremlin.process as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const __ = gremlin.process.statics as any;

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
 * Bulk upload nodes and edges to Neptune graph DB.
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

    const g = await getTraversal();

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
        const exists = await g.V(vertexId).hasNext();

        if (exists && duplicateStrategy === "skip") {
          result.nodesSkipped++;
          // Still process edges for existing nodes
          await processEdges(
            g,
            vertexId,
            item,
            edgeMappings,
            targetCache,
            result
          );
          continue;
        }

        // 3. Build property list
        const properties: Array<{ key: string; value: unknown }> = [];
        for (const mapping of nodeDesign.propertyMappings) {
          if (!mapping.include) continue;
          const value = item[mapping.jsonField];
          if (value === null || value === undefined) continue;
          // Neptune stores primitives; stringify objects
          const storeValue =
            typeof value === "object" ? JSON.stringify(value) : value;
          properties.push({ key: mapping.nodeProperty, value: storeValue });
        }

        // 4. Create or update vertex
        if (exists && duplicateStrategy === "update") {
          // Update existing vertex properties
          let traversal = g.V(vertexId);
          for (const prop of properties) {
            traversal = traversal.property(
              cardinality.single,
              prop.key,
              prop.value
            );
          }
          await traversal.next();
          result.nodesUpdated++;
        } else {
          // Create new vertex
          let traversal = g
            .addV(nodeDesign.nodeLabel)
            .property(T.id, vertexId);
          for (const prop of properties) {
            traversal = traversal.property(prop.key, prop.value);
          }
          await traversal.next();
          result.nodesCreated++;
        }

        // 5. Process edge mappings
        await processEdges(
          g,
          vertexId,
          item,
          edgeMappings,
          targetCache,
          result
        );
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  g: any,
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
      const rawValue = item[rule.sourceField];
      if (rawValue === null || rawValue === undefined || rawValue === "")
        continue;

      // Handle array values (create edge for each)
      const values = Array.isArray(rawValue)
        ? rawValue.map(String)
        : [String(rawValue)];

      for (const value of values) {
        if (!value) continue;

        const cacheKey = `${rule.targetNodeLabel}:${value}`;
        let targetId = targetCache.get(cacheKey);

        // Look up target if not cached
        if (targetId === undefined) {
          const targets = await g
            .V()
            .hasLabel(rule.targetNodeLabel)
            .has(rule.targetMatchProperty, value)
            .id()
            .toList();

          if (targets.length > 0) {
            targetId = String(targets[0]);
          } else if (rule.autoCreateTarget) {
            // Auto-create target node
            const newTargetId = cacheKey;
            await g
              .addV(rule.targetNodeLabel)
              .property(T.id, newTargetId)
              .property(rule.targetMatchProperty, value)
              .next();
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
        let edgeExists: boolean;
        if (rule.direction === "out") {
          edgeExists = await g
            .V(sourceVertexId)
            .outE(rule.edgeLabel)
            .where(__.inV().hasId(targetId))
            .hasNext();
        } else {
          edgeExists = await g
            .V(targetId)
            .outE(rule.edgeLabel)
            .where(__.inV().hasId(sourceVertexId))
            .hasNext();
        }

        if (edgeExists) {
          result.edgesSkipped++;
          continue;
        }

        // Create edge
        if (rule.direction === "out") {
          await g
            .V(sourceVertexId)
            .addE(rule.edgeLabel)
            .to(__.V(targetId))
            .next();
        } else {
          await g
            .V(targetId)
            .addE(rule.edgeLabel)
            .to(__.V(sourceVertexId))
            .next();
        }
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
