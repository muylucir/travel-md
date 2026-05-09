"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Table from "@cloudscape-design/components/table";
import Box from "@cloudscape-design/components/box";
import Badge from "@cloudscape-design/components/badge";
import SpaceBetween from "@cloudscape-design/components/space-between";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import CytoscapeGraph from "../graph/CytoscapeGraph";
import GraphLegend from "../graph/GraphLegend";
import type { GraphTraceCall, GraphNode, GraphLink } from "@/lib/types";

interface GraphTracePanelProps {
  trace: GraphTraceCall[];
}

/**
 * 새 SaleProduct 기획 시 호출된 Knowledge Graph 도구를 시각화한다.
 *
 * - 호출 내역 Table: tool / arguments / source / rows / latency_ms / cypher
 * - 활용 노드 Cytoscape: 도구 호출에서 등장한 정점들을 라벨별로 모아 그린다
 *   (관계는 도구가 명시적으로 트래버스한 엣지를 추론하여 표시)
 */
export default function GraphTracePanel({ trace }: GraphTracePanelProps) {
  const totalQueries = useMemo(
    () => trace.reduce((sum, c) => sum + (c.queries?.length || 0), 0),
    [trace]
  );
  const totalRows = useMemo(
    () =>
      trace.reduce(
        (sum, c) =>
          sum + (c.queries || []).reduce((s, q) => s + (q.rows || 0), 0),
        0
      ),
    [trace]
  );
  const totalLatency = useMemo(
    () => trace.reduce((sum, c) => sum + (c.latency_ms || 0), 0),
    [trace]
  );

  // ─── 활용 노드 추출 ─────────────────────────────────────────────────
  const { nodes, links } = useMemo(
    () => buildSubgraphFromTrace(trace),
    [trace]
  );

  if (trace.length === 0) {
    return null;
  }

  return (
    <Container
      header={
        <Header
          variant="h2"
          description="이 상품을 기획하기 위해 Knowledge Graph 에서 어떤 데이터를 조회했는지"
          counter={`(${trace.length} calls · ${totalQueries} cypher · ${totalRows.toLocaleString()} rows · ${totalLatency.toFixed(1)}ms)`}
        >
          그래프 탐색 트레이스
        </Header>
      }
    >
      <SpaceBetween size="m">
        {/* Summary cards */}
        <ColumnLayout columns={4} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">도구 호출</Box>
            <Box variant="awsui-value-large">{trace.length}</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">Cypher 쿼리</Box>
            <Box variant="awsui-value-large">{totalQueries}</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">반환 row</Box>
            <Box variant="awsui-value-large">{totalRows.toLocaleString()}</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">총 지연</Box>
            <Box variant="awsui-value-large">{totalLatency.toFixed(1)}ms</Box>
          </div>
        </ColumnLayout>

        {/* Subgraph visualization */}
        {nodes.length > 0 && (
          <ExpandableSection
            headerText={`활용된 그래프 영역 (${nodes.length} 정점 / ${links.length} 엣지)`}
            defaultExpanded
            variant="container"
          >
            <SpaceBetween size="s">
              <GraphLegend types={Array.from(new Set(nodes.map((n) => n.type)))} />
              <SubgraphCanvas nodes={nodes} links={links} />
              <Box variant="small" color="text-body-secondary">
                트레이스에서 등장한 정점만 라벨별로 모아서 시각화합니다.
                실제 그래프 구조는 [그래프 탐색기] 탭에서 확인하세요.
              </Box>
            </SpaceBetween>
          </ExpandableSection>
        )}

        {/* Call table */}
        <ExpandableSection
          headerText="도구 호출 내역"
          defaultExpanded
          variant="container"
        >
          <Table
            items={trace}
            variant="embedded"
            columnDefinitions={[
              {
                id: "tool",
                header: "도구",
                cell: (item: GraphTraceCall) => <strong>{item.tool}</strong>,
                width: 200,
              },
              {
                id: "arguments",
                header: "인자",
                cell: (item: GraphTraceCall) => (
                  <code style={{ fontSize: 11 }}>
                    {Object.keys(item.arguments).length === 0
                      ? "(none)"
                      : JSON.stringify(item.arguments)}
                  </code>
                ),
              },
              {
                id: "source",
                header: "소스",
                cell: (item: GraphTraceCall) => (
                  <Badge color={sourceBadgeColor(item.source)}>
                    {item.source}
                  </Badge>
                ),
                width: 100,
              },
              {
                id: "queries",
                header: "쿼리/Rows",
                cell: (item: GraphTraceCall) => {
                  const totalR = (item.queries || []).reduce(
                    (s, q) => s + (q.rows || 0),
                    0
                  );
                  return `${item.queries?.length || 0} / ${totalR}`;
                },
                width: 110,
              },
              {
                id: "latency",
                header: "지연",
                cell: (item: GraphTraceCall) =>
                  `${item.latency_ms.toFixed(1)}ms`,
                width: 90,
              },
            ]}
          />
        </ExpandableSection>

        {/* Detailed cypher per call */}
        <ExpandableSection
          headerText="Cypher 쿼리 전체 보기"
          variant="container"
        >
          <SpaceBetween size="s">
            {trace.map((call, idx) => (
              <Box
                key={idx}
                padding="s"
                color="text-body-secondary"
              >
                <div style={{ marginBottom: 6 }}>
                  <strong>
                    [{idx + 1}] {call.tool}
                  </strong>
                  <span style={{ marginLeft: 8, fontSize: 12 }}>
                    {Object.keys(call.arguments).length > 0
                      ? JSON.stringify(call.arguments)
                      : ""}
                  </span>
                  <Badge color={sourceBadgeColor(call.source)}>
                    {call.source}
                  </Badge>
                </div>
                {(call.queries || []).map((q, qi) => (
                  <div
                    key={qi}
                    style={{
                      borderLeft: "3px solid #d1d5db",
                      paddingLeft: 10,
                      marginBottom: 6,
                    }}
                  >
                    <pre
                      style={{
                        margin: 0,
                        background: "#f8f9fa",
                        padding: 8,
                        borderRadius: 4,
                        fontSize: 11,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {q.cypher}
                    </pre>
                    {Object.keys(q.params || {}).length > 0 && (
                      <div style={{ fontSize: 11, marginTop: 4 }}>
                        params:{" "}
                        <code>{JSON.stringify(q.params)}</code>
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: "#687078" }}>
                      → {q.rows} rows · {q.latency_ms.toFixed(1)}ms
                    </div>
                  </div>
                ))}
                {(!call.queries || call.queries.length === 0) && (
                  <div style={{ fontSize: 12, color: "#687078" }}>
                    (캐시 hit · Cypher 실행 없음)
                  </div>
                )}
              </Box>
            ))}
          </SpaceBetween>
        </ExpandableSection>
      </SpaceBetween>
    </Container>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function sourceBadgeColor(
  source: GraphTraceCall["source"]
): "blue" | "green" | "grey" | "red" {
  switch (source) {
    case "live":
      return "blue";
    case "cache":
    case "agent_cache":
      return "green";
    case "error":
      return "red";
    default:
      return "grey";
  }
}

/**
 * 트레이스를 토대로 시각화용 서브그래프를 만든다.
 *
 * - 정점: tool 호출의 인자(saleProdCd, city) + cypher 의 라벨/리터럴 도시명
 * - 엣지: tool 의 의도된 관계 (예: get_package -> SaleProduct ─VISITS_CITY→ City)
 *
 * 정확한 그래프 데이터를 그리는 게 아니라, "이 기획에 어떤 정점이
 * 활용되었는지" 보여주는 개념적 서브그래프이다.
 */
function buildSubgraphFromTrace(trace: GraphTraceCall[]): {
  nodes: GraphNode[];
  links: GraphLink[];
} {
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  const linkKeys = new Set<string>();

  function addNode(id: string, type: string, label?: string) {
    if (!id || nodes.has(id)) return;
    nodes.set(id, {
      id,
      label: label || id,
      type,
      properties: {},
    });
  }

  function addLink(source: string, target: string, label: string) {
    const key = `${source}→${label}→${target}`;
    if (linkKeys.has(key)) return;
    if (!nodes.has(source) || !nodes.has(target)) return;
    linkKeys.add(key);
    links.push({ id: key, source, target, label });
  }

  // 도구 호출 인자에서 정점/링크 추론 (Score-First redesign)
  for (const call of trace) {
    const args = call.arguments || {};
    switch (call.tool) {
      case "get_reference_package":
      case "find_similar_packages": {
        const code = String(args.saleProdCd || "");
        if (code) addNode(`SaleProduct:${code}`, "SaleProduct", code);
        break;
      }
      case "plan_context_bundle": {
        const code = String(args.saleProdCd || "");
        if (code) addNode(`SaleProduct:${code}`, "SaleProduct", code);
        const ac = String(args.arrival_city || "");
        if (ac) addNode(`City:${ac}`, "City", ac);
        if (args.theme_key)
          addNode(`Theme:${args.theme_key}`, "Theme", String(args.theme_key));
        break;
      }
      case "recommend_route": {
        const ac = String(args.arrival_city || "");
        if (ac) addNode(`City:${ac}`, "City", ac);
        break;
      }
      case "recommend_attractions":
      case "recommend_hotels": {
        const c = String(args.city || "");
        if (c) addNode(`City:${c}`, "City", c);
        if (args.theme_key)
          addNode(`Theme:${args.theme_key}`, "Theme", String(args.theme_key));
        break;
      }
      case "get_attraction_neighbors":
      case "get_attraction_detail":
      case "explain_score": {
        const aid = String(args.attraction_id || "");
        if (aid) {
          const norm = aid.startsWith("Attraction:") ? aid : `Attraction:${aid}`;
          addNode(norm, "Attraction", aid);
        }
        break;
      }
    }

    // Cypher params 에서 도시 리터럴 추출 (e.g. params.dest)
    for (const q of call.queries || []) {
      for (const [, v] of Object.entries(q.params || {})) {
        if (typeof v !== "string") continue;
        // 도시 코드 (3글자 영문)
        if (/^[A-Z]{3}$/.test(v)) {
          addNode(`City:${v}`, "City", v);
        }
      }
    }
  }

  // 의도된 엣지 추가
  const cityIds = Array.from(nodes.values())
    .filter((n) => n.type === "City")
    .map((n) => n.id);
  const saleProductIds = Array.from(nodes.values())
    .filter((n) => n.type === "SaleProduct")
    .map((n) => n.id);

  for (const sp of saleProductIds) {
    for (const c of cityIds) {
      addLink(sp, c, "VISITS_CITY");
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    links,
  };
}

// ─── 작은 Cytoscape 캔버스 (자체 컨테이너 + 리사이즈) ────────────────────

function SubgraphCanvas({
  nodes,
  links,
}: {
  nodes: GraphNode[];
  links: GraphLink[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState({ width: 600, height: 360 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e)
        setDim({
          width: e.contentRect.width,
          height: 360,
        });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{
        position: "relative",
        width: "100%",
        height: 360,
        border: "1px solid #e9ebed",
        borderRadius: 6,
      }}
    >
      <CytoscapeGraph
        nodes={nodes}
        links={links}
        width={dim.width}
        height={dim.height}
        layout="cose"
      />
    </div>
  );
}
