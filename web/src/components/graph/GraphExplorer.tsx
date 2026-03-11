"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Tabs from "@cloudscape-design/components/tabs";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Select from "@cloudscape-design/components/select";
import CytoscapeGraph from "./CytoscapeGraph";
import type { LayoutName } from "./CytoscapeGraph";
import NodeDetailPanel from "./NodeDetailPanel";
import GraphFilterBar from "./GraphFilterBar";
import GraphLegend from "./GraphLegend";
import PackageSubgraph from "./PackageSubgraph";
import type { GraphData, GraphNode } from "@/lib/types";

const LAYOUT_OPTIONS = [
  { value: "cose", label: "Force-Directed (cose)" },
  { value: "concentric", label: "동심원 (concentric)" },
  { value: "breadthfirst", label: "계층형 (breadthfirst)" },
  { value: "circle", label: "원형 (circle)" },
  { value: "grid", label: "그리드 (grid)" },
];

export default function GraphExplorer() {
  const [activeTab, setActiveTab] = useState("full");

  // Full graph state
  const [fullData, setFullData] = useState<GraphData | null>(null);
  const [filteredData, setFilteredData] = useState<GraphData | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [layout, setLayout] = useState<LayoutName>("cose");
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setDimensions({
          width: entry.contentRect.width,
          height: Math.max(entry.contentRect.height, 600),
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const loadFullGraph = useCallback(async (types: string[] = []) => {
    setLoading(true);
    setError(null);
    setSelectedNode(null);
    try {
      const params = types.length > 0 ? `?types=${types.join(",")}` : "";
      const res = await fetch(`/api/graph/visualize${params}`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data: GraphData = await res.json();
      setFullData(data);
      setFilteredData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load full graph on first mount
  useEffect(() => {
    loadFullGraph();
  }, [loadFullGraph]);

  // Client-side filter when types change
  useEffect(() => {
    if (!fullData) return;
    if (selectedTypes.length === 0) {
      setFilteredData(fullData);
      return;
    }
    const typeSet = new Set(selectedTypes);
    const nodes = fullData.nodes.filter((n) => typeSet.has(n.type));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const links = fullData.links.filter(
      (l) => nodeIds.has(l.source as string) && nodeIds.has(l.target as string)
    );
    const stats: Record<string, number> = {};
    for (const n of nodes) {
      stats[n.type] = (stats[n.type] || 0) + 1;
    }
    setFilteredData({ nodes, links, stats });
  }, [selectedTypes, fullData]);

  // Expand neighbors for a node
  const expandNeighbors = useCallback(
    async (nodeId: string) => {
      if (!filteredData) return;
      setExpanding(true);
      try {
        const res = await fetch(
          `/api/graph/visualize/neighbors?id=${encodeURIComponent(nodeId)}`
        );
        if (!res.ok) return;
        const neighborData: GraphData = await res.json();

        // Merge new nodes/links into existing graph
        const existingIds = new Set(filteredData.nodes.map((n) => n.id));
        const newNodes = neighborData.nodes.filter(
          (n) => !existingIds.has(n.id)
        );
        const existingEdgeKeys = new Set(
          filteredData.links.map(
            (l) => `${l.source}-${l.label}-${l.target}`
          )
        );
        const allNodeIds = new Set([
          ...filteredData.nodes.map((n) => n.id),
          ...newNodes.map((n) => n.id),
        ]);
        const newLinks = neighborData.links.filter((l) => {
          const src =
            typeof l.source === "object"
              ? (l.source as any).id
              : l.source;
          const tgt =
            typeof l.target === "object"
              ? (l.target as any).id
              : l.target;
          const key = `${src}-${l.label}-${tgt}`;
          return (
            !existingEdgeKeys.has(key) &&
            allNodeIds.has(src) &&
            allNodeIds.has(tgt)
          );
        });

        const mergedNodes = [...filteredData.nodes, ...newNodes];
        const mergedLinks = [...filteredData.links, ...newLinks];
        const stats: Record<string, number> = {};
        for (const n of mergedNodes) {
          stats[n.type] = (stats[n.type] || 0) + 1;
        }

        const merged = { nodes: mergedNodes, links: mergedLinks, stats };
        setFilteredData(merged);

        // Also update fullData so filter toggle doesn't lose expanded nodes
        if (fullData) {
          const fullIds = new Set(fullData.nodes.map((n) => n.id));
          const extraNodes = newNodes.filter((n) => !fullIds.has(n.id));
          const fullEdgeKeys = new Set(
            fullData.links.map(
              (l) => `${l.source}-${l.label}-${l.target}`
            )
          );
          const allFullIds = new Set([
            ...fullData.nodes.map((n) => n.id),
            ...extraNodes.map((n) => n.id),
          ]);
          const extraLinks = newLinks.filter((l) => {
            const src =
              typeof l.source === "object"
                ? (l.source as any).id
                : l.source;
            const tgt =
              typeof l.target === "object"
                ? (l.target as any).id
                : l.target;
            return (
              !fullEdgeKeys.has(`${src}-${l.label}-${tgt}`) &&
              allFullIds.has(src) &&
              allFullIds.has(tgt)
            );
          });
          setFullData({
            nodes: [...fullData.nodes, ...extraNodes],
            links: [...fullData.links, ...extraLinks],
            stats: merged.stats,
          });
        }
      } catch {
        // silently fail expansion
      } finally {
        setExpanding(false);
      }
    },
    [filteredData, fullData]
  );

  const availableTypes = fullData ? Object.keys(fullData.stats).sort() : [];

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="Neptune Knowledge Graph 시각화">
        그래프 탐색기
      </Header>

      <Tabs
        activeTabId={activeTab}
        onChange={({ detail }) => setActiveTab(detail.activeTabId)}
        tabs={[
          {
            id: "full",
            label: "전체 그래프",
            content: (
              <Container>
                <SpaceBetween size="m">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <GraphFilterBar
                      availableTypes={availableTypes}
                      selectedTypes={selectedTypes}
                      onTypesChange={setSelectedTypes}
                      stats={fullData?.stats || {}}
                    />
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                      }}
                    >
                      <div style={{ minWidth: 200 }}>
                        <Select
                          selectedOption={
                            LAYOUT_OPTIONS.find((o) => o.value === layout) ||
                            LAYOUT_OPTIONS[0]
                          }
                          onChange={({ detail }) =>
                            setLayout(
                              detail.selectedOption.value as LayoutName
                            )
                          }
                          options={LAYOUT_OPTIONS}
                        />
                      </div>
                      <Button
                        iconName="refresh"
                        onClick={() => loadFullGraph()}
                        loading={loading}
                      >
                        새로고침
                      </Button>
                    </div>
                  </div>

                  {loading && (
                    <StatusIndicator type="loading">
                      그래프 데이터 로딩 중...
                    </StatusIndicator>
                  )}
                  {error && (
                    <StatusIndicator type="error">{error}</StatusIndicator>
                  )}

                  {filteredData && !loading && (
                    <>
                      <Box variant="small" color="text-body-secondary">
                        노드 {filteredData.nodes.length}개 / 엣지{" "}
                        {filteredData.links.length}개
                        {expanding && " (확장 중...)"}
                      </Box>
                      <GraphLegend
                        types={
                          selectedTypes.length > 0
                            ? selectedTypes
                            : availableTypes
                        }
                      />
                      <div
                        ref={containerRef}
                        style={{
                          position: "relative",
                          width: "100%",
                          height: 600,
                        }}
                      >
                        <CytoscapeGraph
                          nodes={filteredData.nodes}
                          links={filteredData.links}
                          width={dimensions.width}
                          height={dimensions.height}
                          layout={layout}
                          onNodeClick={setSelectedNode}
                          selectedNodeId={selectedNode?.id}
                        />
                        <NodeDetailPanel
                          node={selectedNode}
                          links={filteredData.links}
                          allNodes={filteredData.nodes}
                          onClose={() => setSelectedNode(null)}
                          onExpand={expandNeighbors}
                        />
                      </div>
                    </>
                  )}
                </SpaceBetween>
              </Container>
            ),
          },
          {
            id: "package",
            label: "패키지 서브그래프",
            content: (
              <Container>
                <PackageSubgraph />
              </Container>
            ),
          },
        ]}
      />
    </SpaceBetween>
  );
}
