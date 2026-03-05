"use client";

import { NODE_TYPE_COLORS } from "@/lib/types";

interface GraphLegendProps {
  types: string[];
}

export default function GraphLegend({ types }: GraphLegendProps) {
  const visibleTypes = types.length > 0 ? types : Object.keys(NODE_TYPE_COLORS);

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        padding: "8px 0",
      }}
    >
      {visibleTypes.map((type) => (
        <div
          key={type}
          style={{ display: "flex", alignItems: "center", gap: 4 }}
        >
          <span
            style={{
              display: "inline-block",
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: NODE_TYPE_COLORS[type] || "#888",
            }}
          />
          <span style={{ fontSize: 13, color: "#545b64" }}>{type}</span>
        </div>
      ))}
    </div>
  );
}
