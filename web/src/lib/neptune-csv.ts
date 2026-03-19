/**
 * Converts JSON data + upload config into Neptune Gremlin CSV format.
 *
 * Neptune CSV format:
 *   Nodes: ~id, ~label, prop1:String, prop2:Int, ...
 *   Edges: ~id, ~from, ~to, ~label
 *
 * @see https://docs.aws.amazon.com/neptune/latest/userguide/bulk-load-tutorial-format-gremlin.html
 */

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

export interface BulkConvertResult {
  nodesCsv: string;
  edgesCsv: string;
  stats: {
    primaryNodes: number;
    targetNodes: number;
    edges: number;
  };
}

function escCsv(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = typeof val === "object" ? JSON.stringify(val) : String(val);
  // Escape quotes and wrap if contains comma, quote, or newline
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function detectNeptuneType(values: unknown[]): string {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number") {
      return Number.isInteger(v) ? "Int" : "Double";
    }
    if (typeof v === "boolean") return "Bool";
  }
  return "String";
}

export function convertToNeptuneCsv(
  data: Record<string, unknown>[],
  nodeDesign: NodeDesignConfig,
  edgeMappings: EdgeMappingRule[]
): BulkConvertResult {
  const includedMappings = nodeDesign.propertyMappings.filter((m) => m.include);
  const stats = { primaryNodes: 0, targetNodes: 0, edges: 0 };

  // --- Detect property types from data sample ---
  const sample = data.slice(0, 100);
  const propTypes = new Map<string, string>();
  for (const m of includedMappings) {
    const values = sample.map((row) => row[m.jsonField]);
    propTypes.set(m.nodeProperty, detectNeptuneType(values));
  }

  // --- Build node header ---
  const nodeHeaders = [
    "~id",
    "~label",
    ...includedMappings.map(
      (m) => `${m.nodeProperty}:${propTypes.get(m.nodeProperty) || "String"}`
    ),
  ];

  // --- Build primary nodes ---
  const nodeRows: string[] = [nodeHeaders.join(",")];
  const nodeIdSet = new Set<string>();

  for (const item of data) {
    const idValue = String(item[nodeDesign.idField] || "");
    if (!idValue) continue;

    const vertexId = `${nodeDesign.nodeLabel}:${idValue}`;
    if (nodeIdSet.has(vertexId)) continue; // deduplicate
    nodeIdSet.add(vertexId);

    const row = [
      escCsv(vertexId),
      escCsv(nodeDesign.nodeLabel),
      ...includedMappings.map((m) => {
        const v = item[m.jsonField];
        if (typeof v === "object" && v !== null) return escCsv(JSON.stringify(v));
        return escCsv(v);
      }),
    ];
    nodeRows.push(row.join(","));
    stats.primaryNodes++;
  }

  // --- Build target nodes and edges ---
  const targetNodes = new Map<string, { id: string; label: string; matchProp: string; value: string }>();
  const edgeRows: string[] = ["~id,~from,~to,~label"];
  const edgeIdSet = new Set<string>();
  let edgeCounter = 0;

  for (const item of data) {
    const idValue = String(item[nodeDesign.idField] || "");
    if (!idValue) continue;
    const sourceId = `${nodeDesign.nodeLabel}:${idValue}`;

    for (const rule of edgeMappings) {
      const rawValue = item[rule.sourceField];
      if (rawValue === null || rawValue === undefined || rawValue === "") continue;

      const values = Array.isArray(rawValue)
        ? rawValue.map(String)
        : [String(rawValue)];

      for (const value of values) {
        if (!value) continue;

        const targetId = `${rule.targetNodeLabel}:${value}`;

        // Track target node for auto-creation
        if (rule.autoCreateTarget && !targetNodes.has(targetId)) {
          targetNodes.set(targetId, {
            id: targetId,
            label: rule.targetNodeLabel,
            matchProp: rule.targetMatchProperty,
            value,
          });
        }

        // Create edge (deduplicate)
        const from = rule.direction === "out" ? sourceId : targetId;
        const to = rule.direction === "out" ? targetId : sourceId;
        const edgeKey = `${from}:${rule.edgeLabel}:${to}`;

        if (!edgeIdSet.has(edgeKey)) {
          edgeIdSet.add(edgeKey);
          edgeCounter++;
          edgeRows.push(
            [escCsv(`e-${edgeCounter}`), escCsv(from), escCsv(to), escCsv(rule.edgeLabel)].join(",")
          );
          stats.edges++;
        }
      }
    }
  }

  // --- Append target nodes to a separate CSV ---
  // Target nodes have a simple structure: ~id, ~label, matchProp:String
  if (targetNodes.size > 0) {
    // Group by label to create proper headers
    const byLabel = new Map<string, typeof targetNodes extends Map<string, infer V> ? V[] : never>();
    for (const tn of targetNodes.values()) {
      const list = byLabel.get(tn.label) || [];
      list.push(tn);
      byLabel.set(tn.label, list);
    }

    for (const [, targets] of byLabel) {
      const matchProp = targets[0].matchProp;
      // Add target nodes with same header as primary (compatible)
      // We create a minimal row: ~id, ~label, matchProp
      for (const tn of targets) {
        // Append to nodeRows with empty columns for non-matching properties
        const row = [
          escCsv(tn.id),
          escCsv(tn.label),
          ...includedMappings.map((m) =>
            m.nodeProperty === matchProp ? escCsv(tn.value) : ""
          ),
        ];
        nodeRows.push(row.join(","));
        stats.targetNodes++;
      }
    }
  }

  return {
    nodesCsv: nodeRows.join("\n"),
    edgesCsv: edgeRows.join("\n"),
    stats,
  };
}
