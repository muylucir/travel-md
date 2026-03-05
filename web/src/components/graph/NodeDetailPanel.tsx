"use client";

import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Badge from "@cloudscape-design/components/badge";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import type { GraphNode } from "@/lib/types";
import { NODE_TYPE_COLORS } from "@/lib/types";

interface NodeDetailPanelProps {
  node: GraphNode | null;
  onClose: () => void;
}

export default function NodeDetailPanel({ node, onClose }: NodeDetailPanelProps) {
  if (!node) return null;

  const color = NODE_TYPE_COLORS[node.type] || "#888888";
  const props = node.properties;

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        width: 340,
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
        <Box variant="small" color="text-body-secondary">
          ID: {node.id}
        </Box>

        <ColumnLayout columns={1}>
          {Object.entries(props).map(([key, value]) => {
            if (value === null || value === undefined) return null;
            const display =
              typeof value === "object" ? JSON.stringify(value) : String(value);
            return (
              <div key={key}>
                <Box variant="awsui-key-label">{key}</Box>
                <Box>{display}</Box>
              </div>
            );
          })}
        </ColumnLayout>
      </SpaceBetween>
    </div>
  );
}
