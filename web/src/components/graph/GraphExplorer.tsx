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
import ColumnLayout from "@cloudscape-design/components/column-layout";
import CytoscapeGraph from "./CytoscapeGraph";
import type { LayoutName } from "./CytoscapeGraph";
import NodeDetailPanel from "./NodeDetailPanel";
import GraphFilterBar from "./GraphFilterBar";
import GraphLegend from "./GraphLegend";
import PackageSubgraph from "./PackageSubgraph";
import SchemaOverview from "./SchemaOverview";
import type { GraphData, GraphNode } from "@/lib/types";

const LAYOUT_OPTIONS = [
  { value: "cose", label: "Force-Directed (cose)" },
  { value: "concentric", label: "동심원 (concentric)" },
  { value: "breadthfirst", label: "계층형 (breadthfirst)" },
  { value: "circle", label: "원형 (circle)" },
  { value: "grid", label: "그리드 (grid)" },
];

const DEFAULT_LIMIT = 200;

interface GraphStats {
  nodeCountByType: Record<string, number>;
  edgeCountByLabel: Record<string, number>;
  totalNodes: number;
  totalEdges: number;
}

export default function GraphExplorer() {
  const [activeTab, setActiveTab] = useState("schema");

  // Stats (loaded instantly)
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  // Full graph state
  const [fullData, setFullData] = useState<GraphData | null>(null);
  const [filteredData, setFilteredData] = useState<GraphData | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [layout, setLayout] = useState<LayoutName>("cose");
  const [nodeLimit, setNodeLimit] = useState(DEFAULT_LIMIT);
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

  // Load stats instantly on mount
  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const res = await fetch("/api/graph/stats");
      if (res.ok) {
        const data: GraphStats = await res.json();
        setStats(data);
      }
    } catch {
      // Stats failure is non-critical
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // Load graph with limit
  const loadGraph = useCallback(
    async (types: string[] = [], limit: number = DEFAULT_LIMIT) => {
      setLoading(true);
      setError(null);
      setSelectedNode(null);
      try {
        const params = new URLSearchParams();
        if (types.length > 0) params.set("types", types.join(","));
        if (limit > 0) params.set("limit", String(limit));
        else params.set("limit", "0");

        const qs = params.toString();
        const res = await fetch(`/api/graph/visualize${qs ? `?${qs}` : ""}`);
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
    },
    []
  );

  // Load limited graph on mount (after stats)
  useEffect(() => {
    loadGraph([], DEFAULT_LIMIT);
  }, [loadGraph]);

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
    const linkStats: Record<string, number> = {};
    for (const n of nodes) {
      linkStats[n.type] = (linkStats[n.type] || 0) + 1;
    }
    setFilteredData({ nodes, links, stats: linkStats });
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
              ? (l.source as { id: string }).id
              : l.source;
          const tgt =
            typeof l.target === "object"
              ? (l.target as { id: string }).id
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
        const mergedStats: Record<string, number> = {};
        for (const n of mergedNodes) {
          mergedStats[n.type] = (mergedStats[n.type] || 0) + 1;
        }

        const merged = {
          nodes: mergedNodes,
          links: mergedLinks,
          stats: mergedStats,
        };
        setFilteredData(merged);

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
                ? (l.source as { id: string }).id
                : l.source;
            const tgt =
              typeof l.target === "object"
                ? (l.target as { id: string }).id
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

  const availableTypes = stats
    ? Object.keys(stats.nodeCountByType).sort()
    : fullData
      ? Object.keys(fullData.stats).sort()
      : [];

  const displayedNodeCount = filteredData?.nodes.length || 0;
  const totalNodeCount = stats?.totalNodes || 0;
  const isPartial = nodeLimit > 0 && displayedNodeCount < totalNodeCount;

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="v3 Knowledge Graph — 간사이 4도시 (OSA·UKY·UKB·ARN), 6,691 정점 / 30,108 엣지"
      >
        그래프 탐색기
      </Header>

      {/* Stats summary cards */}
      {stats && !statsLoading && (
        <Container>
          <ColumnLayout columns={4} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">총 노드</Box>
              <Box variant="awsui-value-large">
                {stats.totalNodes.toLocaleString()}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">총 엣지</Box>
              <Box variant="awsui-value-large">
                {stats.totalEdges.toLocaleString()}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">노드 타입</Box>
              <Box variant="awsui-value-large">
                {Object.keys(stats.nodeCountByType).length}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">엣지 타입</Box>
              <Box variant="awsui-value-large">
                {Object.keys(stats.edgeCountByLabel).length}
              </Box>
            </div>
          </ColumnLayout>
        </Container>
      )}

      <Tabs
        activeTabId={activeTab}
        onChange={({ detail }) => setActiveTab(detail.activeTabId)}
        tabs={[
          {
            id: "schema",
            label: "스키마 개요",
            content: <SchemaOverview />,
          },
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
                      stats={stats?.nodeCountByType || fullData?.stats || {}}
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
                      {isPartial && (
                        <Button
                          onClick={() => {
                            setNodeLimit(0);
                            loadGraph(
                              selectedTypes.length > 0
                                ? selectedTypes
                                : [],
                              0
                            );
                          }}
                          loading={loading}
                        >
                          전체 로드
                        </Button>
                      )}
                      <Button
                        iconName="refresh"
                        onClick={() => {
                          setNodeLimit(DEFAULT_LIMIT);
                          loadGraph([], DEFAULT_LIMIT);
                          loadStats();
                        }}
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
                        노드 {filteredData.nodes.length.toLocaleString()}
                        {isPartial &&
                          ` / ${totalNodeCount.toLocaleString()}`}
                        개 / 엣지{" "}
                        {filteredData.links.length.toLocaleString()}개
                        {isPartial && (
                          <Box
                            variant="small"
                            color="text-status-info"
                            display="inline"
                            margin={{ left: "xs" }}
                          >
                            (상위 {nodeLimit}개 노드만 표시 중)
                          </Box>
                        )}
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
