"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import Tabs from "@cloudscape-design/components/tabs";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Alert from "@cloudscape-design/components/alert";
import RadioGroup from "@cloudscape-design/components/radio-group";
import Pagination from "@cloudscape-design/components/pagination";
import CytoscapeGraph from "@/components/graph/CytoscapeGraph";
import type { GraphNode, GraphLink } from "@/lib/types";
import { NODE_TYPE_COLORS } from "@/lib/types";
import type {
  NodeDesignConfig,
  EdgeMappingRule,
  DuplicateStrategy,
  DuplicateInfo,
} from "./types";

interface PreviewStepProps {
  rawData: Record<string, unknown>[];
  nodeDesign: NodeDesignConfig;
  edgeMappings: EdgeMappingRule[];
  duplicateStrategy: DuplicateStrategy;
  onDuplicateStrategyChange: (strategy: DuplicateStrategy) => void;
}

const GRAPH_PREVIEW_LIMIT = 50;
const TABLE_PAGE_SIZE = 20;

function buildPreviewGraph(
  rawData: Record<string, unknown>[],
  nodeDesign: NodeDesignConfig,
  edgeMappings: EdgeMappingRule[]
): { nodes: GraphNode[]; links: GraphLink[] } {
  const previewData = rawData.slice(0, GRAPH_PREVIEW_LIMIT);
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const targetNodeMap = new Map<string, GraphNode>();
  const linkKeys = new Set<string>();

  for (const item of previewData) {
    const idValue = String(item[nodeDesign.idField] || "");
    if (!idValue) continue;
    const nodeId = `${nodeDesign.nodeLabel}:${idValue}`;

    const properties: Record<string, unknown> = {};
    for (const m of nodeDesign.propertyMappings) {
      if (m.include) {
        properties[m.nodeProperty] = item[m.jsonField];
      }
    }

    nodes.push({
      id: nodeId,
      label: idValue.length > 20 ? idValue.slice(0, 18) + "..." : idValue,
      type: nodeDesign.nodeLabel,
      properties,
    });

    for (const rule of edgeMappings) {
      const value = item[rule.sourceField];
      if (value === null || value === undefined || value === "") continue;
      const strValue = String(value);

      const targetKey = `${rule.targetNodeLabel}:${strValue}`;
      if (!targetNodeMap.has(targetKey)) {
        targetNodeMap.set(targetKey, {
          id: targetKey,
          label: strValue,
          type: rule.targetNodeLabel,
          properties: { [rule.targetMatchProperty]: strValue },
        });
      }

      const source = rule.direction === "out" ? nodeId : targetKey;
      const target = rule.direction === "out" ? targetKey : nodeId;
      const linkKey = `${source}:${rule.edgeLabel}:${target}`;

      if (!linkKeys.has(linkKey)) {
        linkKeys.add(linkKey);
        links.push({
          id: `edge:${linkKey}`,
          source,
          target,
          label: rule.edgeLabel,
        });
      }
    }
  }

  for (const node of targetNodeMap.values()) {
    nodes.push(node);
  }

  return { nodes, links };
}

export default function PreviewStep({
  rawData,
  nodeDesign,
  edgeMappings,
  duplicateStrategy,
  onDuplicateStrategyChange,
}: PreviewStepProps) {
  const [activeTab, setActiveTab] = useState("table");
  const [tablePage, setTablePage] = useState(1);

  // Duplicate check state
  const [duplicates, setDuplicates] = useState<DuplicateInfo[]>([]);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [duplicateChecked, setDuplicateChecked] = useState(false);

  // Graph container
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const [graphDimensions, setGraphDimensions] = useState({
    width: 800,
    height: 500,
  });

  useEffect(() => {
    const el = graphContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setGraphDimensions({
          width: entry.contentRect.width,
          height: Math.max(entry.contentRect.height, 500),
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeTab]);

  // Build preview data for table
  const tableItems = useMemo(() => {
    return rawData.map((item) => {
      const mapped: Record<string, unknown> = {
        __vertexId: `${nodeDesign.nodeLabel}:${item[nodeDesign.idField]}`,
      };
      for (const m of nodeDesign.propertyMappings) {
        if (m.include) {
          mapped[m.nodeProperty] = item[m.jsonField];
        }
      }
      return mapped;
    });
  }, [rawData, nodeDesign]);

  const tableColumns = useMemo(() => {
    const cols = [
      {
        id: "__vertexId",
        header: "Vertex ID",
        cell: (item: Record<string, unknown>) => (
          <Box variant="code">{String(item.__vertexId)}</Box>
        ),
        width: 220,
      },
    ];
    for (const m of nodeDesign.propertyMappings) {
      if (m.include) {
        cols.push({
          id: m.nodeProperty,
          header: m.nodeProperty,
          cell: (item: Record<string, unknown>) => {
            const v = item[m.nodeProperty];
            if (v === null || v === undefined) return <Box>-</Box>;
            if (typeof v === "object")
              return <Box>{JSON.stringify(v)}</Box>;
            return <Box>{String(v)}</Box>;
          },
          width: 160,
        });
      }
    }
    return cols;
  }, [nodeDesign]);

  const pagedItems = tableItems.slice(
    (tablePage - 1) * TABLE_PAGE_SIZE,
    tablePage * TABLE_PAGE_SIZE
  );

  // Build preview graph
  const previewGraph = useMemo(
    () => buildPreviewGraph(rawData, nodeDesign, edgeMappings),
    [rawData, nodeDesign, edgeMappings]
  );

  // Stats
  const stats = useMemo(() => {
    const nodesByType: Record<string, number> = {};
    for (const n of previewGraph.nodes) {
      nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
    }
    const edgesByLabel: Record<string, number> = {};
    for (const l of previewGraph.links) {
      edgesByLabel[l.label] = (edgesByLabel[l.label] || 0) + 1;
    }
    // Estimate full counts (preview might be limited)
    const ratio = rawData.length / Math.min(rawData.length, GRAPH_PREVIEW_LIMIT);
    const estimatedNodes = Math.round(
      (nodesByType[nodeDesign.nodeLabel] || 0) * ratio
    );
    const uniqueTargets = Object.entries(nodesByType)
      .filter(([t]) => t !== nodeDesign.nodeLabel)
      .reduce((sum, [, c]) => sum + c, 0);

    return {
      totalRecords: rawData.length,
      estimatedNodes,
      uniqueTargets,
      edgeRules: edgeMappings.length,
      nodesByType,
      edgesByLabel,
      previewNodeCount: previewGraph.nodes.length,
      previewEdgeCount: previewGraph.links.length,
    };
  }, [rawData, previewGraph, nodeDesign, edgeMappings]);

  // Duplicate check
  const checkDuplicates = useCallback(async () => {
    setCheckingDuplicates(true);
    setDuplicateError(null);
    try {
      const values = rawData.map((item) =>
        String(item[nodeDesign.idField] || "")
      );
      const uniqueValues = [...new Set(values.filter(Boolean))];

      const res = await fetch("/api/graph/upload/check-duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeLabel: nodeDesign.nodeLabel,
          values: uniqueValues,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const existingSet = new Set<string>(data.existingValues || []);
      const found: DuplicateInfo[] = [];
      for (const v of uniqueValues) {
        if (existingSet.has(v)) {
          found.push({
            idValue: v,
            vertexId: `${nodeDesign.nodeLabel}:${v}`,
          });
        }
      }
      setDuplicates(found);
      setDuplicateChecked(true);
    } catch (err) {
      setDuplicateError(
        err instanceof Error ? err.message : "중복 검사에 실패했습니다."
      );
    } finally {
      setCheckingDuplicates(false);
    }
  }, [rawData, nodeDesign]);

  return (
    <SpaceBetween size="l">
      <Tabs
        activeTabId={activeTab}
        onChange={({ detail }) => setActiveTab(detail.activeTabId)}
        tabs={[
          {
            id: "table",
            label: "데이터 테이블",
            content: (
              <Container
                header={
                  <Header
                    variant="h2"
                    counter={`(${tableItems.length})`}
                    description={`${nodeDesign.nodeLabel} 노드로 생성될 데이터`}
                  >
                    노드 데이터
                  </Header>
                }
              >
                <SpaceBetween size="m">
                  <Table
                    items={pagedItems}
                    columnDefinitions={tableColumns}
                    variant="embedded"
                    stripedRows
                    wrapLines
                  />
                  {tableItems.length > TABLE_PAGE_SIZE && (
                    <Pagination
                      currentPageIndex={tablePage}
                      pagesCount={Math.ceil(
                        tableItems.length / TABLE_PAGE_SIZE
                      )}
                      onChange={({ detail }) =>
                        setTablePage(detail.currentPageIndex)
                      }
                    />
                  )}
                </SpaceBetween>
              </Container>
            ),
          },
          {
            id: "graph",
            label: "그래프 미리보기",
            content: (
              <Container
                header={
                  <Header variant="h2">
                    그래프 미리보기
                    {rawData.length > GRAPH_PREVIEW_LIMIT && (
                      <Box
                        variant="small"
                        color="text-body-secondary"
                        display="inline"
                        margin={{ left: "s" }}
                      >
                        (상위 {GRAPH_PREVIEW_LIMIT}건만 표시)
                      </Box>
                    )}
                  </Header>
                }
              >
                <SpaceBetween size="s">
                  <Box variant="small" color="text-body-secondary">
                    노드 {previewGraph.nodes.length}개 / 엣지{" "}
                    {previewGraph.links.length}개
                  </Box>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {Object.entries(stats.nodesByType).map(([type, count]) => (
                      <Box
                        key={type}
                        variant="small"
                        display="inline"
                        padding={{ horizontal: "xs", vertical: "xxs" }}
                      >
                        <span
                          style={{
                            display: "inline-block",
                            width: 10,
                            height: 10,
                            borderRadius: "50%",
                            backgroundColor:
                              NODE_TYPE_COLORS[type] || "#888",
                            marginRight: 4,
                          }}
                        />
                        {type} ({count})
                      </Box>
                    ))}
                  </div>
                  <div
                    ref={graphContainerRef}
                    style={{
                      position: "relative",
                      width: "100%",
                      height: 500,
                    }}
                  >
                    {previewGraph.nodes.length > 0 ? (
                      <CytoscapeGraph
                        nodes={previewGraph.nodes}
                        links={previewGraph.links}
                        width={graphDimensions.width}
                        height={graphDimensions.height}
                        layout="cose"
                      />
                    ) : (
                      <Box
                        textAlign="center"
                        color="text-body-secondary"
                        padding="xxl"
                      >
                        미리보기할 그래프 데이터가 없습니다.
                      </Box>
                    )}
                  </div>
                </SpaceBetween>
              </Container>
            ),
          },
          {
            id: "duplicates",
            label: `중복 검사${duplicateChecked ? ` (${duplicates.length})` : ""}`,
            content: (
              <Container
                header={
                  <Header
                    variant="h2"
                    actions={
                      <Button
                        onClick={checkDuplicates}
                        loading={checkingDuplicates}
                        iconName="search"
                      >
                        중복 검사 실행
                      </Button>
                    }
                  >
                    중복 검사
                  </Header>
                }
              >
                <SpaceBetween size="m">
                  {!duplicateChecked && !checkingDuplicates && (
                    <Box color="text-body-secondary" textAlign="center" padding="l">
                      &quot;중복 검사 실행&quot; 버튼을 클릭하여 기존 그래프와의
                      중복을 확인하세요.
                    </Box>
                  )}

                  {checkingDuplicates && (
                    <StatusIndicator type="loading">
                      Neptune에서 중복 데이터를 확인하고 있습니다...
                    </StatusIndicator>
                  )}

                  {duplicateError && (
                    <Alert type="error">{duplicateError}</Alert>
                  )}

                  {duplicateChecked && !checkingDuplicates && (
                    <>
                      {duplicates.length === 0 ? (
                        <Alert type="success">
                          중복된 노드가 없습니다. 모든 데이터가 새로
                          생성됩니다.
                        </Alert>
                      ) : (
                        <>
                          <Alert type="warning">
                            {duplicates.length}개의 중복 노드가 발견되었습니다.
                            아래에서 처리 방법을 선택하세요.
                          </Alert>

                          <FormFieldWrapper label="중복 처리 방법">
                            <RadioGroup
                              value={duplicateStrategy}
                              onChange={({ detail }) =>
                                onDuplicateStrategyChange(
                                  detail.value as DuplicateStrategy
                                )
                              }
                              items={[
                                {
                                  value: "skip",
                                  label: "건너뛰기",
                                  description:
                                    "중복된 노드는 무시하고 새 노드만 생성합니다.",
                                },
                                {
                                  value: "update",
                                  label: "업데이트",
                                  description:
                                    "중복된 노드의 속성을 새 데이터로 덮어씁니다.",
                                },
                                {
                                  value: "create",
                                  label: "새로 생성",
                                  description:
                                    "중복 여부와 관계없이 모든 노드를 새로 생성합니다 (ID 충돌 가능).",
                                },
                              ]}
                            />
                          </FormFieldWrapper>

                          <Table
                            items={duplicates}
                            columnDefinitions={[
                              {
                                id: "idValue",
                                header: "ID 값",
                                cell: (item) => item.idValue,
                              },
                              {
                                id: "vertexId",
                                header: "기존 Vertex ID",
                                cell: (item) => (
                                  <Box variant="code">{item.vertexId}</Box>
                                ),
                              },
                            ]}
                            variant="embedded"
                            stripedRows
                            header={
                              <Header
                                variant="h3"
                                counter={`(${duplicates.length})`}
                              >
                                중복 노드 목록
                              </Header>
                            }
                          />
                        </>
                      )}
                    </>
                  )}
                </SpaceBetween>
              </Container>
            ),
          },
          {
            id: "stats",
            label: "통계 요약",
            content: (
              <SpaceBetween size="l">
                <Container header={<Header variant="h2">업로드 통계 요약</Header>}>
                  <ColumnLayout columns={4} variant="text-grid">
                    <div>
                      <Box variant="awsui-key-label">총 레코드</Box>
                      <Box variant="awsui-value-large">
                        {stats.totalRecords.toLocaleString()}
                      </Box>
                    </div>
                    <div>
                      <Box variant="awsui-key-label">
                        생성 노드 ({nodeDesign.nodeLabel})
                      </Box>
                      <Box variant="awsui-value-large">
                        {stats.estimatedNodes.toLocaleString()}
                      </Box>
                    </div>
                    <div>
                      <Box variant="awsui-key-label">연결 대상 노드 (추정)</Box>
                      <Box variant="awsui-value-large">
                        {stats.uniqueTargets.toLocaleString()}
                      </Box>
                    </div>
                    <div>
                      <Box variant="awsui-key-label">엣지 규칙</Box>
                      <Box variant="awsui-value-large">{stats.edgeRules}</Box>
                    </div>
                  </ColumnLayout>
                </Container>

                {Object.keys(stats.nodesByType).length > 0 && (
                  <Container
                    header={<Header variant="h2">노드 타입별 분포 (미리보기)</Header>}
                  >
                    <Table
                      items={Object.entries(stats.nodesByType).map(
                        ([type, count]) => ({ type, count })
                      )}
                      columnDefinitions={[
                        {
                          id: "color",
                          header: "",
                          cell: (item) => (
                            <span
                              style={{
                                display: "inline-block",
                                width: 12,
                                height: 12,
                                borderRadius: "50%",
                                backgroundColor:
                                  NODE_TYPE_COLORS[item.type] || "#888",
                              }}
                            />
                          ),
                          width: 40,
                        },
                        {
                          id: "type",
                          header: "노드 타입",
                          cell: (item) => (
                            <Box fontWeight="bold">{item.type}</Box>
                          ),
                        },
                        {
                          id: "count",
                          header: "개수",
                          cell: (item) => item.count.toLocaleString(),
                        },
                      ]}
                      variant="embedded"
                      stripedRows
                    />
                  </Container>
                )}

                {Object.keys(stats.edgesByLabel).length > 0 && (
                  <Container
                    header={
                      <Header variant="h2">엣지 라벨별 분포 (미리보기)</Header>
                    }
                  >
                    <Table
                      items={Object.entries(stats.edgesByLabel).map(
                        ([label, count]) => ({ label, count })
                      )}
                      columnDefinitions={[
                        {
                          id: "label",
                          header: "엣지 라벨",
                          cell: (item) => (
                            <Box variant="code">{item.label}</Box>
                          ),
                        },
                        {
                          id: "count",
                          header: "개수",
                          cell: (item) => item.count.toLocaleString(),
                        },
                      ]}
                      variant="embedded"
                      stripedRows
                    />
                  </Container>
                )}
              </SpaceBetween>
            ),
          },
        ]}
      />
    </SpaceBetween>
  );
}

// Simple wrapper since FormField import would add another dependency
function FormFieldWrapper({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Box variant="awsui-key-label" margin={{ bottom: "xxs" }}>
        {label}
      </Box>
      {children}
    </div>
  );
}
