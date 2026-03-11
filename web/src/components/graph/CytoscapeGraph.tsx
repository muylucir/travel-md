"use client";

import { useRef, useEffect, useCallback, useMemo } from "react";
import cytoscape from "cytoscape";
import type { GraphNode, GraphLink } from "@/lib/types";
import { NODE_TYPE_COLORS } from "@/lib/types";

export type LayoutName =
  | "cose"
  | "breadthfirst"
  | "concentric"
  | "circle"
  | "grid";

interface CytoscapeGraphProps {
  nodes: GraphNode[];
  links: GraphLink[];
  width: number;
  height: number;
  layout?: LayoutName;
  onNodeClick?: (node: GraphNode) => void;
  selectedNodeId?: string | null;
  rootNodeId?: string | null;
}

const LAYOUT_OPTIONS: Record<LayoutName, cytoscape.LayoutOptions> = {
  cose: {
    name: "cose",
    animate: false,
    nodeRepulsion: () => 8000,
    idealEdgeLength: () => 80,
    gravity: 0.3,
    numIter: 300,
    nodeDimensionsIncludeLabels: true,
  } as cytoscape.LayoutOptions,
  breadthfirst: {
    name: "breadthfirst",
    animate: false,
    directed: true,
    spacingFactor: 1.2,
    nodeDimensionsIncludeLabels: true,
  } as cytoscape.LayoutOptions,
  concentric: {
    name: "concentric",
    animate: false,
    minNodeSpacing: 30,
    concentric: (node: cytoscape.NodeSingular) => node.degree(false),
    levelWidth: () => 2,
    nodeDimensionsIncludeLabels: true,
  } as cytoscape.LayoutOptions,
  circle: {
    name: "circle",
    animate: false,
    nodeDimensionsIncludeLabels: true,
  } as cytoscape.LayoutOptions,
  grid: {
    name: "grid",
    animate: false,
    nodeDimensionsIncludeLabels: true,
    condense: true,
  } as cytoscape.LayoutOptions,
};

export default function CytoscapeGraph({
  nodes,
  links,
  width,
  height,
  layout = "cose",
  onNodeClick,
  selectedNodeId,
  rootNodeId,
}: CytoscapeGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;

  // Build node map for click handler
  const nodeMap = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const n of nodes) map.set(n.id, n);
    return map;
  }, [nodes]);

  // Convert to cytoscape elements
  const elements = useMemo(() => {
    const cyNodes: cytoscape.ElementDefinition[] = nodes.map((n) => ({
      data: {
        id: n.id,
        label: n.label.length > 16 ? n.label.slice(0, 14) + "..." : n.label,
        fullLabel: n.label,
        type: n.type,
        nodeColor: NODE_TYPE_COLORS[n.type] || "#888888",
        nodeSize: n.type === "Package" ? 40 : 28,
      },
    }));

    const nodeIdSet = new Set(nodes.map((n) => n.id));
    const cyEdges: cytoscape.ElementDefinition[] = links
      .filter((l) => nodeIdSet.has(l.source) && nodeIdSet.has(l.target))
      .map((l) => ({
        data: {
          id: l.id || `${l.source}-${l.label}-${l.target}`,
          source: l.source,
          target: l.target,
          label: l.label,
        },
      }));

    return [...cyNodes, ...cyEdges];
  }, [nodes, links]);

  // Initialize cytoscape
  useEffect(() => {
    if (!containerRef.current || elements.length === 0) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(nodeColor)",
            label: "data(label)",
            "font-size": "10px",
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 4,
            color: "#232f3e",
            width: "data(nodeSize)",
            height: "data(nodeSize)",
            "border-width": 0,
            "text-outline-width": 2,
            "text-outline-color": "#ffffff",
            "text-outline-opacity": 0.8,
            "overlay-opacity": 0,
            "transition-property":
              "border-width, border-color, background-color",
            "transition-duration": 150,
          } as cytoscape.Css.Node,
        },
        {
          selector: "node:active",
          style: {
            "overlay-opacity": 0,
          } as cytoscape.Css.Node,
        },
        {
          selector: "node.hover",
          style: {
            "border-width": 3,
            "border-color": "#0972d3",
            "font-size": "12px",
            "z-index": 999,
          } as cytoscape.Css.Node,
        },
        {
          selector: "node.selected",
          style: {
            "border-width": 3,
            "border-color": "#ff9900",
            "background-color": "#ff9900",
            "font-size": "12px",
            "z-index": 999,
          } as cytoscape.Css.Node,
        },
        {
          selector: "node.neighbor",
          style: {
            "border-width": 2,
            "border-color": "#ff9900",
            opacity: 1,
          } as cytoscape.Css.Node,
        },
        {
          selector: "node.dimmed",
          style: {
            opacity: 0.15,
          } as cytoscape.Css.Node,
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#adb5bd",
            "target-arrow-color": "#adb5bd",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.8,
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": "8px",
            color: "#687078",
            "text-rotation": "autorotate",
            "text-margin-y": -8,
            "text-outline-width": 1.5,
            "text-outline-color": "#ffffff",
            "text-outline-opacity": 0.8,
            "text-opacity": 0,
            "overlay-opacity": 0,
            "transition-property": "line-color, target-arrow-color, opacity",
            "transition-duration": 150,
          } as cytoscape.Css.Edge,
        },
        {
          selector: "edge.highlighted",
          style: {
            width: 2.5,
            "line-color": "#ff9900",
            "target-arrow-color": "#ff9900",
            "text-opacity": 1,
            "font-size": "9px",
            "z-index": 999,
          } as cytoscape.Css.Edge,
        },
        {
          selector: "edge.dimmed",
          style: {
            opacity: 0.08,
          } as cytoscape.Css.Edge,
        },
      ],
      layout: { name: "preset" },
      minZoom: 0.1,
      maxZoom: 5,
      wheelSensitivity: 0.3,
      boxSelectionEnabled: false,
    });

    // Node click
    cy.on("tap", "node", (evt) => {
      const nodeId = evt.target.id();
      const graphNode = nodeMap.get(nodeId);
      if (graphNode && onNodeClickRef.current) {
        onNodeClickRef.current(graphNode);
      }
    });

    // Hover highlight
    cy.on("mouseover", "node", (evt) => {
      const node = evt.target;
      node.addClass("hover");
      node.connectedEdges().addClass("highlighted");
      node.neighborhood("node").addClass("neighbor");
      // Dim unrelated nodes/edges
      cy.elements()
        .not(node)
        .not(node.connectedEdges())
        .not(node.neighborhood("node"))
        .addClass("dimmed");
    });

    cy.on("mouseout", "node", () => {
      cy.elements().removeClass("hover highlighted neighbor dimmed");
    });

    // Edge label on zoom
    cy.on("zoom", () => {
      const zoom = cy.zoom();
      cy.edges().style("text-opacity", zoom > 1.2 ? 1 : 0);
    });

    cyRef.current = cy;

    // Run layout
    const layoutOpts = { ...LAYOUT_OPTIONS[layout] };
    if (
      layout === "breadthfirst" &&
      rootNodeId &&
      cy.getElementById(rootNodeId).length > 0
    ) {
      (layoutOpts as Record<string, unknown>).roots = `#${CSS.escape(rootNodeId)}`;
    }
    cy.layout(layoutOpts).run();
    cy.fit(undefined, 30);

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements, layout, rootNodeId]);

  // Update selection highlight
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.elements().removeClass("selected");
    if (selectedNodeId) {
      const node = cy.getElementById(selectedNodeId);
      if (node.length > 0) {
        node.addClass("selected");
      }
    }
  }, [selectedNodeId]);

  // Resize
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.resize();
  }, [width, height]);

  const handleFit = useCallback(() => {
    cyRef.current?.fit(undefined, 30);
  }, []);

  return (
    <div style={{ position: "relative", width, height }}>
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", borderRadius: 4 }}
      />
      <button
        onClick={handleFit}
        style={{
          position: "absolute",
          bottom: 8,
          left: 8,
          background: "#fff",
          border: "1px solid #d5dbdb",
          borderRadius: 4,
          padding: "4px 10px",
          fontSize: 12,
          cursor: "pointer",
          color: "#545b64",
          boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
        }}
        title="전체 보기"
      >
        Fit
      </button>
    </div>
  );
}
