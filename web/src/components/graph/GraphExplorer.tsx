"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Tabs from "@cloudscape-design/components/tabs";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ForceGraph from "./ForceGraph";
import NodeDetailPanel from "./NodeDetailPanel";
import GraphFilterBar from "./GraphFilterBar";
import GraphLegend from "./GraphLegend";
import PackageSubgraph from "./PackageSubgraph";
import type { GraphData, GraphNode } from "@/lib/types";

export default function GraphExplorer() {
  const [activeTab, setActiveTab] = useState("full");

  // Full graph state
  const [fullData, setFullData] = useState<GraphData | null>(null);
  const [filteredData, setFilteredData] = useState<GraphData | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 500 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setDimensions({
          width: entry.contentRect.width,
          height: Math.max(entry.contentRect.height, 500),
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
                    }}
                  >
                    <GraphFilterBar
                      availableTypes={availableTypes}
                      selectedTypes={selectedTypes}
                      onTypesChange={setSelectedTypes}
                      stats={fullData?.stats || {}}
                    />
                    <Button
                      iconName="refresh"
                      onClick={() => loadFullGraph()}
                      loading={loading}
                    >
                      새로고침
                    </Button>
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
                          height: 500,
                        }}
                      >
                        <ForceGraph
                          nodes={filteredData.nodes}
                          links={filteredData.links}
                          width={dimensions.width}
                          height={dimensions.height}
                          onNodeClick={setSelectedNode}
                          selectedNodeId={selectedNode?.id}
                        />
                        <NodeDetailPanel
                          node={selectedNode}
                          onClose={() => setSelectedNode(null)}
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
