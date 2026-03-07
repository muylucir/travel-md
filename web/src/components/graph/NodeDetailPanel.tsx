"use client";

import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Badge from "@cloudscape-design/components/badge";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import type { GraphNode, GraphLink } from "@/lib/types";
import { NODE_TYPE_COLORS } from "@/lib/types";

interface NodeDetailPanelProps {
  node: GraphNode | null;
  links?: GraphLink[];
  allNodes?: GraphNode[];
  onClose: () => void;
  onExpand?: (nodeId: string) => void;
}

export default function NodeDetailPanel({
  node,
  links,
  allNodes,
  onClose,
  onExpand,
}: NodeDetailPanelProps) {
  if (!node) return null;

  const color = NODE_TYPE_COLORS[node.type] || "#888888";
  const props = node.properties;

  // Find edges connected to this node
  const connectedEdges = (links || []).filter(
    (l) => {
      const src = typeof l.source === "object" ? (l.source as any).id : l.source;
      const tgt = typeof l.target === "object" ? (l.target as any).id : l.target;
      return src === node.id || tgt === node.id;
    }
  );

  // Group edges by label
  const edgeGroups: Record<string, { label: string; direction: string; targetNode?: GraphNode }[]> = {};
  const nodeMap = new Map((allNodes || []).map((n) => [n.id, n]));

  for (const edge of connectedEdges) {
    const src = typeof edge.source === "object" ? (edge.source as any).id : edge.source;
    const tgt = typeof edge.target === "object" ? (edge.target as any).id : edge.target;
    const isOutgoing = src === node.id;
    const otherId = isOutgoing ? tgt : src;
    const otherNode = nodeMap.get(otherId);

    const group = edgeGroups[edge.label] || [];
    group.push({
      label: otherNode?.label || otherId,
      direction: isOutgoing ? "→" : "←",
      targetNode: otherNode,
    });
    edgeGroups[edge.label] = group;
  }

  // Key properties to show (skip noisy ones)
  const skipKeys = new Set(["id", "label", "T.id", "T.label", "hashtags", "highlights", "promotions", "product_tags"]);

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        width: 360,
        maxHeight: "calc(100% - 16px)",
        overflow: "auto",
        background: "#fff",
        border: "1px solid #d5dbdb",
        borderRadius: 8,
        padding: 16,
        zIndex: 10,
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      }}
    >
      <SpaceBetween size="s">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Badge color={color as never}>{node.type}</Badge>
          <button
            onClick={onClose}
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              fontSize: 18,
              color: "#545b64",
            }}
          >
            ✕
          </button>
        </div>

        <Box variant="h3">{node.label}</Box>

        {onExpand && (
          <Button
            variant="normal"
            iconName="expand"
            onClick={() => onExpand(node.id)}
          >
            이웃 노드 펼치기
          </Button>
        )}

        <ColumnLayout columns={1}>
          {Object.entries(props).map(([key, value]) => {
            if (value === null || value === undefined) return null;
            if (skipKeys.has(key)) return null;
            const display =
              typeof value === "object" ? JSON.stringify(value) : String(value);
            if (!display || display === "[]" || display === "{}") return null;
            return (
              <div key={key}>
                <Box variant="awsui-key-label">{key}</Box>
                <Box>{display.length > 80 ? display.slice(0, 80) + "…" : display}</Box>
              </div>
            );
          })}
        </ColumnLayout>

        {Object.keys(edgeGroups).length > 0 && (
          <>
            <Box variant="h4" margin={{ top: "s" }}>연결 관계</Box>
            {Object.entries(edgeGroups).map(([edgeLabel, items]) => (
              <div key={edgeLabel} style={{ marginBottom: 8 }}>
                <Box variant="awsui-key-label">
                  {edgeLabel} ({items.length})
                </Box>
                <div style={{ fontSize: 12, color: "#545b64", maxHeight: 120, overflow: "auto" }}>
                  {items.slice(0, 10).map((item, i) => (
                    <div key={i}>
                      {item.direction} {item.targetNode && (
                        <span style={{ color: NODE_TYPE_COLORS[item.targetNode.type] || "#888", fontWeight: 500 }}>
                          [{item.targetNode.type}]
                        </span>
                      )}{" "}
                      {item.label}
                    </div>
                  ))}
                  {items.length > 10 && (
                    <div style={{ color: "#687078" }}>...외 {items.length - 10}개</div>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </SpaceBetween>
    </div>
  );
}
