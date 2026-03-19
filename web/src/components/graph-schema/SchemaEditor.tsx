"use client";

import { useState, useMemo, useCallback } from "react";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Select from "@cloudscape-design/components/select";
import Toggle from "@cloudscape-design/components/toggle";
import Button from "@cloudscape-design/components/button";
import Table from "@cloudscape-design/components/table";
import Box from "@cloudscape-design/components/box";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Autosuggest from "@cloudscape-design/components/autosuggest";
import Alert from "@cloudscape-design/components/alert";
import CytoscapeGraph from "@/components/graph/CytoscapeGraph";
import type { GraphNode, GraphLink } from "@/lib/types";
import { NODE_TYPE_COLORS } from "@/lib/types";
import {
  EXISTING_NODE_LABELS,
  COMMON_EDGE_LABELS,
  type GraphSchema,
  type SchemaProperty,
  type SchemaEdge,
} from "@/components/graph-upload/types";

interface SchemaEditorProps {
  initial?: GraphSchema | null;
  onSave: (schema: Omit<GraphSchema, "schemaId" | "createdAt" | "updatedAt">) => void;
  onCancel: () => void;
  saving?: boolean;
}

const PROPERTY_TYPES = [
  { value: "string", label: "string" },
  { value: "number", label: "number" },
  { value: "boolean", label: "boolean" },
  { value: "json", label: "json (배열/객체)" },
];

const CUSTOM_LABEL = "__custom__";

export default function SchemaEditor({
  initial,
  onSave,
  onCancel,
  saving,
}: SchemaEditorProps) {
  const [name, setName] = useState(initial?.name || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [nodeLabel, setNodeLabel] = useState(initial?.nodeLabel || "");
  const [useCustomLabel, setUseCustomLabel] = useState(
    initial ? !EXISTING_NODE_LABELS.includes(initial.nodeLabel) : false
  );
  const [idField, setIdField] = useState(initial?.idField || "");
  const [properties, setProperties] = useState<SchemaProperty[]>(
    initial?.properties || [{ name: "", type: "string", required: true }]
  );
  const [edges, setEdges] = useState<SchemaEdge[]>(initial?.edges || []);
  const [importMsg, setImportMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // --- Import schema definition from JSON file ---
  const handleImportSchema = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const schema = JSON.parse(ev.target?.result as string);

          if (!schema.nodeLabel) {
            setImportMsg({ type: "error", text: "nodeLabel 필드가 필요합니다." });
            return;
          }

          // Apply schema definition to form
          if (schema.name) setName(schema.name);
          if (schema.description) setDescription(schema.description);
          setNodeLabel(schema.nodeLabel);
          setUseCustomLabel(!EXISTING_NODE_LABELS.includes(schema.nodeLabel));
          if (schema.idField) setIdField(schema.idField);

          if (Array.isArray(schema.properties)) {
            setProperties(
              schema.properties.map((p: Record<string, unknown>) => ({
                name: String(p.name || ""),
                type: (p.type as SchemaProperty["type"]) || "string",
                required: Boolean(p.required),
              }))
            );
          }

          if (Array.isArray(schema.edges)) {
            setEdges(
              schema.edges.map((e: Record<string, unknown>) => ({
                sourceField: String(e.sourceField || ""),
                targetNodeLabel: String(e.targetNodeLabel || ""),
                targetMatchProperty: String(e.targetMatchProperty || "name"),
                edgeLabel: String(e.edgeLabel || ""),
                direction: (e.direction as "out" | "in") || "out",
                autoCreateTarget: e.autoCreateTarget !== false,
              }))
            );
          }

          const propCount = schema.properties?.length || 0;
          const edgeCount = schema.edges?.length || 0;
          setImportMsg({
            type: "success",
            text: `"${schema.name || schema.nodeLabel}" 스키마 로드 완료 — 속성 ${propCount}개, 엣지 ${edgeCount}개`,
          });
        } catch {
          setImportMsg({ type: "error", text: "JSON 파싱에 실패했습니다. 형식을 확인하세요." });
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    []
  );

  // --- Export current schema as JSON ---
  const handleExportSchema = useCallback(() => {
    const schema = {
      name,
      description,
      nodeLabel,
      idField,
      properties: properties.filter((p) => p.name),
      edges: edges.filter((e) => e.sourceField && e.targetNodeLabel && e.edgeLabel),
    };
    const blob = new Blob([JSON.stringify(schema, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${nodeLabel || "schema"}.schema.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [name, description, nodeLabel, idField, properties, edges]);

  const labelOptions = [
    ...EXISTING_NODE_LABELS.map((l) => ({ value: l, label: l })),
    { value: CUSTOM_LABEL, label: "새 타입 직접 입력..." },
  ];

  const targetLabelOptions = EXISTING_NODE_LABELS.filter(
    (l) => l !== nodeLabel
  ).map((l) => ({ value: l, label: l }));

  // --- Property CRUD ---
  const addProperty = () =>
    setProperties([...properties, { name: "", type: "string", required: false }]);

  const removeProperty = (idx: number) =>
    setProperties(properties.filter((_, i) => i !== idx));

  const updateProperty = (idx: number, update: Partial<SchemaProperty>) =>
    setProperties(properties.map((p, i) => (i === idx ? { ...p, ...update } : p)));

  // --- Edge CRUD ---
  const addEdge = () =>
    setEdges([
      ...edges,
      {
        sourceField: "",
        targetNodeLabel: "",
        targetMatchProperty: "name",
        edgeLabel: "",
        direction: "out",
        autoCreateTarget: true,
      },
    ]);

  const removeEdge = (idx: number) =>
    setEdges(edges.filter((_, i) => i !== idx));

  const updateEdge = (idx: number, update: Partial<SchemaEdge>) =>
    setEdges(edges.map((e, i) => (i === idx ? { ...e, ...update } : e)));

  // --- Schema preview graph ---
  const previewGraph = useMemo(() => {
    const nodes: GraphNode[] = [];
    const links: GraphLink[] = [];

    if (!nodeLabel) return { nodes, links };

    // Main node
    const mainId = `schema:${nodeLabel}`;
    const propNames = properties
      .filter((p) => p.name)
      .map((p) => `${p.name}: ${p.type}${p.required ? " *" : ""}`)
      .join("\n");
    nodes.push({
      id: mainId,
      label: nodeLabel,
      type: nodeLabel,
      properties: { _desc: propNames, idField },
    });

    // Edge targets
    const targetSet = new Set<string>();
    for (const edge of edges) {
      if (!edge.targetNodeLabel || !edge.edgeLabel) continue;
      const targetId = `schema:${edge.targetNodeLabel}`;
      if (!targetSet.has(targetId)) {
        targetSet.add(targetId);
        nodes.push({
          id: targetId,
          label: edge.targetNodeLabel,
          type: edge.targetNodeLabel,
          properties: {},
        });
      }
      const src = edge.direction === "out" ? mainId : targetId;
      const tgt = edge.direction === "out" ? targetId : mainId;
      links.push({
        id: `edge:${src}:${edge.edgeLabel}:${tgt}`,
        source: src,
        target: tgt,
        label: edge.edgeLabel,
      });
    }

    return { nodes, links };
  }, [nodeLabel, properties, edges, idField]);

  const handleSave = () => {
    onSave({
      name,
      description,
      nodeLabel,
      idField,
      properties: properties.filter((p) => p.name),
      edges: edges.filter((e) => e.sourceField && e.targetNodeLabel && e.edgeLabel),
    });
  };

  const isValid = name && nodeLabel && idField && properties.some((p) => p.name);

  return (
    <SpaceBetween size="l">
      {/* Schema JSON Import / Export */}
      <Container
        header={
          <Header variant="h2">
            스키마 JSON 가져오기 / 내보내기
          </Header>
        }
      >
        <SpaceBetween size="m">
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              id="schema-json-import"
              type="file"
              accept=".json"
              onChange={handleImportSchema}
              style={{ display: "none" }}
            />
            <Button
              iconName="upload"
              onClick={() =>
                document.getElementById("schema-json-import")?.click()
              }
            >
              JSON에서 가져오기
            </Button>
            <Button
              iconName="download"
              onClick={handleExportSchema}
              disabled={!nodeLabel}
            >
              JSON으로 내보내기
            </Button>
            <Box variant="small" color="text-body-secondary">
              스키마 정의 JSON 파일을 가져오거나, 현재 설정을 내보낼 수 있습니다
            </Box>
          </div>
          {importMsg && (
            <Alert
              type={importMsg.type}
              dismissible
              onDismiss={() => setImportMsg(null)}
            >
              {importMsg.text}
            </Alert>
          )}
        </SpaceBetween>
      </Container>

      {/* Basic Info */}
      <Container header={<Header variant="h2">기본 정보</Header>}>
        <ColumnLayout columns={2}>
          <FormField label="스키마 이름" constraintText="표시될 이름">
            <Input
              value={name}
              onChange={({ detail }) => setName(detail.value)}
              placeholder="예: 관광지 스키마"
            />
          </FormField>
          <FormField label="설명">
            <Input
              value={description}
              onChange={({ detail }) => setDescription(detail.value)}
              placeholder="선택사항"
            />
          </FormField>
        </ColumnLayout>
      </Container>

      {/* Node Definition */}
      <Container header={<Header variant="h2">노드 정의</Header>}>
        <SpaceBetween size="m">
          <ColumnLayout columns={2}>
            <FormField label="노드 라벨" description="그래프에 생성될 노드 타입">
              <Select
                selectedOption={
                  useCustomLabel
                    ? { value: CUSTOM_LABEL, label: "새 타입 직접 입력..." }
                    : labelOptions.find((o) => o.value === nodeLabel) || null
                }
                onChange={({ detail }) => {
                  if (detail.selectedOption.value === CUSTOM_LABEL) {
                    setUseCustomLabel(true);
                    setNodeLabel("");
                  } else {
                    setUseCustomLabel(false);
                    setNodeLabel(detail.selectedOption.value!);
                  }
                }}
                options={labelOptions}
                placeholder="노드 타입 선택"
              />
            </FormField>
            {useCustomLabel && (
              <FormField label="커스텀 라벨">
                <Input
                  value={nodeLabel}
                  onChange={({ detail }) => setNodeLabel(detail.value)}
                  placeholder="PascalCase (예: Restaurant)"
                />
              </FormField>
            )}
            <FormField label="ID 필드" description="JSON에서 고유 식별자로 사용할 필드명">
              <Input
                value={idField}
                onChange={({ detail }) => setIdField(detail.value)}
                placeholder="예: name, code, id"
              />
            </FormField>
          </ColumnLayout>
        </SpaceBetween>
      </Container>

      {/* Properties */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <Button onClick={addProperty} iconName="add-plus">
                속성 추가
              </Button>
            }
          >
            속성 정의
          </Header>
        }
      >
        {properties.length === 0 ? (
          <Box textAlign="center" color="text-body-secondary" padding="l">
            속성을 추가하세요.
          </Box>
        ) : (
          <Table
            items={properties.map((p, i) => ({ ...p, _idx: i }))}
            columnDefinitions={[
              {
                id: "name",
                header: "속성명 (= JSON 필드명)",
                cell: (item) => (
                  <Input
                    value={item.name}
                    onChange={({ detail }) =>
                      updateProperty(item._idx, { name: detail.value })
                    }
                    placeholder="예: name"
                  />
                ),
                width: 200,
              },
              {
                id: "type",
                header: "타입",
                cell: (item) => (
                  <Select
                    selectedOption={
                      PROPERTY_TYPES.find((t) => t.value === item.type) || null
                    }
                    onChange={({ detail }) =>
                      updateProperty(item._idx, {
                        type: detail.selectedOption.value as SchemaProperty["type"],
                      })
                    }
                    options={PROPERTY_TYPES}
                  />
                ),
                width: 160,
              },
              {
                id: "required",
                header: "필수",
                cell: (item) => (
                  <Toggle
                    checked={item.required}
                    onChange={({ detail }) =>
                      updateProperty(item._idx, { required: detail.checked })
                    }
                  />
                ),
                width: 80,
              },
              {
                id: "actions",
                header: "",
                cell: (item) => (
                  <Button
                    variant="icon"
                    iconName="remove"
                    onClick={() => removeProperty(item._idx)}
                  />
                ),
                width: 50,
              },
            ]}
            variant="embedded"
            stripedRows
          />
        )}
      </Container>

      {/* Edges */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <Button onClick={addEdge} iconName="add-plus">
                엣지 추가
              </Button>
            }
            description="JSON 필드 값이 다른 노드와 연결될 관계를 정의합니다."
          >
            엣지 정의
          </Header>
        }
      >
        <SpaceBetween size="m">
          {edges.length === 0 && (
            <Box textAlign="center" color="text-body-secondary" padding="l">
              엣지 규칙이 없습니다. 필요시 추가하세요.
            </Box>
          )}
          {edges.map((edge, idx) => (
            <Container
              key={idx}
              header={
                <Header
                  variant="h3"
                  actions={
                    <Button
                      variant="icon"
                      iconName="remove"
                      onClick={() => removeEdge(idx)}
                    />
                  }
                >
                  엣지 #{idx + 1}
                  {edge.sourceField && edge.edgeLabel && edge.targetNodeLabel && (
                    <Box
                      variant="small"
                      color="text-body-secondary"
                      display="inline"
                      margin={{ left: "s" }}
                    >
                      {nodeLabel || "?"} —[{edge.edgeLabel}]
                      {edge.direction === "out" ? "→" : "←"}{" "}
                      {edge.targetNodeLabel}
                    </Box>
                  )}
                </Header>
              }
            >
              <ColumnLayout columns={3}>
                <FormField label="소스 필드 (JSON)">
                  <Input
                    value={edge.sourceField}
                    onChange={({ detail }) =>
                      updateEdge(idx, { sourceField: detail.value })
                    }
                    placeholder="예: city"
                  />
                </FormField>
                <FormField label="대상 노드 타입">
                  <Select
                    selectedOption={
                      targetLabelOptions.find(
                        (o) => o.value === edge.targetNodeLabel
                      ) || null
                    }
                    onChange={({ detail }) =>
                      updateEdge(idx, {
                        targetNodeLabel: detail.selectedOption.value!,
                      })
                    }
                    options={targetLabelOptions}
                    placeholder="선택"
                  />
                </FormField>
                <FormField label="매칭 속성">
                  <Input
                    value={edge.targetMatchProperty}
                    onChange={({ detail }) =>
                      updateEdge(idx, { targetMatchProperty: detail.value })
                    }
                    placeholder="name"
                  />
                </FormField>
                <FormField label="엣지 라벨">
                  <Autosuggest
                    value={edge.edgeLabel}
                    onChange={({ detail }) =>
                      updateEdge(idx, { edgeLabel: detail.value })
                    }
                    options={COMMON_EDGE_LABELS.map((l) => ({ value: l }))}
                    placeholder="LOCATED_IN"
                    enteredTextLabel={(v) => `사용: "${v}"`}
                  />
                </FormField>
                <FormField label="방향">
                  <Select
                    selectedOption={{
                      value: edge.direction,
                      label:
                        edge.direction === "out"
                          ? `→ (${nodeLabel || "현재"} → ${edge.targetNodeLabel || "대상"})`
                          : `← (${edge.targetNodeLabel || "대상"} → ${nodeLabel || "현재"})`,
                    }}
                    onChange={({ detail }) =>
                      updateEdge(idx, {
                        direction: detail.selectedOption.value as "out" | "in",
                      })
                    }
                    options={[
                      { value: "out", label: `→ (${nodeLabel || "현재"} → 대상)` },
                      { value: "in", label: `← (대상 → ${nodeLabel || "현재"})` },
                    ]}
                  />
                </FormField>
                <FormField label="자동 생성">
                  <Toggle
                    checked={edge.autoCreateTarget}
                    onChange={({ detail }) =>
                      updateEdge(idx, { autoCreateTarget: detail.checked })
                    }
                  >
                    대상 노드 없으면 생성
                  </Toggle>
                </FormField>
              </ColumnLayout>
            </Container>
          ))}
        </SpaceBetween>
      </Container>

      {/* Preview */}
      {previewGraph.nodes.length > 0 && (
        <Container header={<Header variant="h2">스키마 미리보기</Header>}>
          <SpaceBetween size="s">
            <div style={{ display: "flex", gap: 8 }}>
              {previewGraph.nodes.map((n) => (
                <Box key={n.id} variant="small" display="inline" padding={{ horizontal: "xs" }}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      backgroundColor: NODE_TYPE_COLORS[n.type] || "#888",
                      marginRight: 4,
                    }}
                  />
                  {n.type}
                </Box>
              ))}
            </div>
            <div style={{ height: 300, position: "relative" }}>
              <CytoscapeGraph
                nodes={previewGraph.nodes}
                links={previewGraph.links}
                width={800}
                height={300}
                layout="cose"
              />
            </div>
          </SpaceBetween>
        </Container>
      )}

      {/* Actions */}
      <SpaceBetween direction="horizontal" size="xs">
        <Button variant="link" onClick={onCancel}>
          취소
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={!isValid}
          loading={saving}
        >
          {initial ? "스키마 수정" : "스키마 생성"}
        </Button>
      </SpaceBetween>
    </SpaceBetween>
  );
}
