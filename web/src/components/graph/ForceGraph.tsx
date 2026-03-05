"use client";

import { useRef, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import type { GraphNode, GraphLink } from "@/lib/types";
import { NODE_TYPE_COLORS } from "@/lib/types";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
});

interface ForceGraphProps {
  nodes: GraphNode[];
  links: GraphLink[];
  width: number;
  height: number;
  onNodeClick?: (node: GraphNode) => void;
  selectedNodeId?: string | null;
}

export default function ForceGraph({
  nodes,
  links,
  width,
  height,
  onNodeClick,
  selectedNodeId,
}: ForceGraphProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);

  useEffect(() => {
    if (fgRef.current && nodes.length > 0) {
      fgRef.current.d3Force("charge")?.strength(-80);
      fgRef.current.d3Force("link")?.distance(60);
    }
  }, [nodes.length]);

  const handleNodeClick = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any) => {
      if (onNodeClick) {
        onNodeClick(node as GraphNode);
      }
    },
    [onNodeClick]
  );

  const nodeColor = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any) => {
      const n = node as GraphNode;
      if (selectedNodeId && n.id === selectedNodeId) return "#ff9900";
      return NODE_TYPE_COLORS[n.type] || "#888888";
    },
    [selectedNodeId]
  );

  const nodeVal = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any) => {
      const n = node as GraphNode;
      return n.type === "Package" ? 4 : 2;
    },
    []
  );

  const nodeCanvasObject = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const n = node as GraphNode & { x: number; y: number };
      const size = n.type === "Package" ? 6 : 4;
      const color =
        selectedNodeId && n.id === selectedNodeId
          ? "#ff9900"
          : NODE_TYPE_COLORS[n.type] || "#888888";

      // Draw node circle
      ctx.beginPath();
      ctx.arc(n.x, n.y, size, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();

      // Draw label when zoomed in enough
      if (globalScale > 1.5) {
        const labelText =
          n.label.length > 20 ? n.label.slice(0, 18) + "…" : n.label;
        const fontSize = Math.max(10 / globalScale, 2);
        ctx.font = `${fontSize}px Sans-Serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "#232f3e";
        ctx.fillText(labelText, n.x, n.y + size + 1);
      }
    },
    [selectedNodeId]
  );

  if (nodes.length === 0) return null;

  return (
    <ForceGraph2D
      ref={fgRef}
      graphData={{ nodes, links }}
      width={width}
      height={height}
      nodeId="id"
      nodeColor={nodeColor}
      nodeVal={nodeVal}
      nodeCanvasObject={nodeCanvasObject}
      linkColor={() => "#d5dbdb"}
      linkWidth={0.5}
      linkDirectionalArrowLength={3}
      linkDirectionalArrowRelPos={1}
      onNodeClick={handleNodeClick}
      cooldownTicks={100}
      warmupTicks={50}
    />
  );
}
