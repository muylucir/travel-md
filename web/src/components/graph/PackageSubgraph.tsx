"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import SpaceBetween from "@cloudscape-design/components/space-between";
import FormField from "@cloudscape-design/components/form-field";
import Autosuggest from "@cloudscape-design/components/autosuggest";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Box from "@cloudscape-design/components/box";
import Select from "@cloudscape-design/components/select";
import CytoscapeGraph from "./CytoscapeGraph";
import type { LayoutName } from "./CytoscapeGraph";
import NodeDetailPanel from "./NodeDetailPanel";
import GraphLegend from "./GraphLegend";
import type { GraphData, GraphNode } from "@/lib/types";

const LAYOUT_OPTIONS = [
  { value: "concentric", label: "동심원 (concentric)" },
  { value: "breadthfirst", label: "계층형 (breadthfirst)" },
  { value: "cose", label: "Force-Directed (cose)" },
  { value: "circle", label: "원형 (circle)" },
];

export default function PackageSubgraph() {
  const [code, setCode] = useState("");
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [suggestions, setSuggestions] = useState<{ value: string }[]>([]);
  const [layout, setLayout] = useState<LayoutName>("concentric");
  const [rootNodeId, setRootNodeId] = useState<string | null>(null);
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

  // Fetch package codes for autosuggest
  const fetchSuggestions = useCallback(async (value: string) => {
    if (value.length < 2) {
      setSuggestions([]);
      return;
    }
    try {
      const res = await fetch(`/api/packages?limit=10`);
      if (res.ok) {
        const pkgs = await res.json();
        const codes = pkgs
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((p: any) => p.code)
          .filter((c: string) =>
            c.toLowerCase().includes(value.toLowerCase())
          )
          .slice(0, 10);
        setSuggestions(codes.map((c: string) => ({ value: c })));
      }
    } catch {
      // ignore
    }
  }, []);

  const loadSubgraph = useCallback(async (packageCode: string) => {
    if (!packageCode.trim()) return;
    setLoading(true);
    setError(null);
    setSelectedNode(null);
    try {
      const res = await fetch(
        `/api/graph/visualize/package?code=${encodeURIComponent(packageCode.trim())}`
      );
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const graphData: GraphData = await res.json();
      setData(graphData);
      // Find the Package node as root
      const pkgNode = graphData.nodes.find((n) => n.type === "Package");
      setRootNodeId(pkgNode?.id || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "오류가 발생했습니다.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <SpaceBetween size="m">
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "flex-end",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: 1, minWidth: 260 }}>
          <FormField label="패키지 코드">
            <Autosuggest
              value={code}
              onChange={({ detail }) => setCode(detail.value)}
              onSelect={({ detail }) => {
                setCode(detail.value);
                loadSubgraph(detail.value);
              }}
              onLoadItems={({ detail }) =>
                fetchSuggestions(detail.filteringText)
              }
              options={suggestions}
              placeholder="패키지 코드 입력 (예: AVP231260401OZC)"
              enteredTextLabel={(value) => `"${value}" 검색`}
              onKeyDown={(e) => {
                if (e.detail.key === "Enter") loadSubgraph(code);
              }}
              empty="결과 없음"
            />
          </FormField>
        </div>
        <div style={{ minWidth: 200 }}>
          <FormField label="레이아웃">
            <Select
              selectedOption={
                LAYOUT_OPTIONS.find((o) => o.value === layout) ||
                LAYOUT_OPTIONS[0]
              }
              onChange={({ detail }) =>
                setLayout(detail.selectedOption.value as LayoutName)
              }
              options={LAYOUT_OPTIONS}
            />
          </FormField>
        </div>
      </div>

      {loading && <StatusIndicator type="loading">로딩 중...</StatusIndicator>}
      {error && <StatusIndicator type="error">{error}</StatusIndicator>}

      {data && (
        <>
          <Box variant="small" color="text-body-secondary">
            노드 {data.nodes.length}개 / 엣지 {data.links.length}개
          </Box>
          <GraphLegend types={Object.keys(data.stats)} />
          <div
            ref={containerRef}
            style={{ position: "relative", width: "100%", height: 600 }}
          >
            <CytoscapeGraph
              nodes={data.nodes}
              links={data.links}
              width={dimensions.width}
              height={dimensions.height}
              layout={layout}
              onNodeClick={setSelectedNode}
              selectedNodeId={selectedNode?.id}
              rootNodeId={rootNodeId}
            />
            <NodeDetailPanel
              node={selectedNode}
              onClose={() => setSelectedNode(null)}
            />
          </div>
        </>
      )}
    </SpaceBetween>
  );
}
