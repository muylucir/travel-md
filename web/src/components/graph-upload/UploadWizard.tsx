"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Wizard from "@cloudscape-design/components/wizard";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Alert from "@cloudscape-design/components/alert";
import FileUploadStep from "./FileUploadStep";
import NodeDesignStep from "./NodeDesignStep";
import EdgeMappingStep from "./EdgeMappingStep";
import PreviewStep from "./PreviewStep";
import UploadStep from "./UploadStep";
import {
  FIELD_TO_NODE_HINTS,
  type GraphSchema,
  type NodeDesignConfig,
  type EdgeMappingRule,
  type DuplicateStrategy,
  type UploadResult,
} from "./types";

function generateId() {
  return Math.random().toString(36).slice(2, 9);
}

export default function UploadWizard() {
  const router = useRouter();
  const [activeStepIndex, setActiveStepIndex] = useState(0);

  // Schema selection
  const [selectedSchema, setSelectedSchema] = useState<GraphSchema | null>(null);

  // Step 1: File upload
  const [rawData, setRawData] = useState<Record<string, unknown>[] | null>(
    null
  );
  const [fileName, setFileName] = useState("");
  const [jsonFields, setJsonFields] = useState<string[]>([]);

  // Step 2: Node design
  const [nodeDesign, setNodeDesign] = useState<NodeDesignConfig>({
    nodeLabel: "",
    idField: "",
    propertyMappings: [],
  });

  // Step 3: Edge mapping
  const [edgeMappings, setEdgeMappings] = useState<EdgeMappingRule[]>([]);

  // Step 4: Preview
  const [duplicateStrategy, setDuplicateStrategy] =
    useState<DuplicateStrategy>("skip");

  // Step 5: Upload
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);

  // Validation errors
  const [validationError, setValidationError] = useState<string | null>(null);

  // Apply schema to node design and edge mappings
  const applySchemaToFields = useCallback(
    (schema: GraphSchema | null, fields: string[]) => {
      if (schema) {
        // Schema-driven mapping
        const schemaFieldNames = new Set(schema.properties.map((p) => p.name));
        const mappings = fields.map((f) => ({
          jsonField: f,
          nodeProperty: f,
          include: schemaFieldNames.has(f),
        }));

        setNodeDesign({
          nodeLabel: schema.nodeLabel,
          idField: schema.idField,
          propertyMappings: mappings,
        });

        setEdgeMappings(
          schema.edges.map((e) => ({
            id: generateId(),
            sourceField: e.sourceField,
            targetNodeLabel: e.targetNodeLabel,
            targetMatchProperty: e.targetMatchProperty,
            edgeLabel: e.edgeLabel,
            direction: e.direction as "out" | "in",
            autoCreateTarget: e.autoCreateTarget,
          }))
        );
      } else {
        // Manual mode: all fields included, auto-suggest edges
        const mappings = fields.map((f) => ({
          jsonField: f,
          nodeProperty: f,
          include: true,
        }));
        setNodeDesign((prev) => ({
          ...prev,
          propertyMappings: mappings,
          idField: fields[0] || "",
        }));

        const autoEdges: EdgeMappingRule[] = [];
        for (const field of fields) {
          const hint = FIELD_TO_NODE_HINTS[field.toLowerCase()];
          if (hint) {
            autoEdges.push({
              id: generateId(),
              sourceField: field,
              targetNodeLabel: hint.nodeLabel,
              targetMatchProperty: hint.matchProp,
              edgeLabel: hint.edgeLabel,
              direction: "out",
              autoCreateTarget: true,
            });
          }
        }
        setEdgeMappings(autoEdges);
      }
    },
    []
  );

  // Schema selection handler
  const handleSchemaSelect = useCallback(
    (schema: GraphSchema | null) => {
      setSelectedSchema(schema);
      // Re-apply mapping if data is already loaded
      if (rawData && jsonFields.length > 0) {
        applySchemaToFields(schema, jsonFields);
      }
    },
    [rawData, jsonFields, applySchemaToFields]
  );

  // File load handler
  const handleFileLoad = useCallback(
    (data: Record<string, unknown>[], name: string) => {
      setRawData(data);
      setFileName(name);

      const fields = Object.keys(data[0] || {});
      setJsonFields(fields);

      applySchemaToFields(selectedSchema, fields);

      // Reset downstream state
      setDuplicateStrategy("skip");
      setUploadResult(null);
    },
    [selectedSchema, applySchemaToFields]
  );

  // Validate current step before navigation
  const validateStep = (step: number): boolean => {
    setValidationError(null);

    switch (step) {
      case 0:
        if (!rawData) {
          setValidationError("JSON 파일을 먼저 업로드하세요.");
          return false;
        }
        return true;

      case 1:
        if (!nodeDesign.nodeLabel) {
          setValidationError("노드 라벨을 선택하세요.");
          return false;
        }
        if (!nodeDesign.idField) {
          setValidationError("ID 필드를 선택하세요.");
          return false;
        }
        return true;

      case 2:
        // Edge mappings are optional, but validate filled rules
        for (const rule of edgeMappings) {
          if (!rule.sourceField || !rule.targetNodeLabel || !rule.edgeLabel) {
            setValidationError(
              "엣지 규칙의 모든 필수 필드를 채우거나 불완전한 규칙을 삭제하세요."
            );
            return false;
          }
        }
        return true;

      case 3:
        return true;

      default:
        return true;
    }
  };

  // Upload handler
  const handleUpload = useCallback(async () => {
    if (!rawData) return;

    setUploading(true);
    setUploadResult(null);

    try {
      const res = await fetch("/api/graph/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: rawData,
          nodeDesign,
          edgeMappings: edgeMappings.filter(
            (r) => r.sourceField && r.targetNodeLabel && r.edgeLabel
          ),
          duplicateStrategy,
        }),
      });

      const result = await res.json();
      setUploadResult(result);
    } catch (err) {
      setUploadResult({
        nodesCreated: 0,
        nodesSkipped: 0,
        nodesUpdated: 0,
        edgesCreated: 0,
        edgesSkipped: 0,
        targetNodesCreated: 0,
        errors: [
          `업로드 요청 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`,
        ],
        durationMs: 0,
      });
    } finally {
      setUploading(false);
    }
  }, [rawData, nodeDesign, edgeMappings, duplicateStrategy]);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="JSON 파일을 그래프 DB에 업로드합니다. 노드 타입, 속성, 관계를 설정할 수 있습니다."
      >
        그래프 데이터 업로드
      </Header>

      {validationError && (
        <Alert
          type="error"
          dismissible
          onDismiss={() => setValidationError(null)}
        >
          {validationError}
        </Alert>
      )}

      <Wizard
        i18nStrings={{
          stepNumberLabel: (n) => `단계 ${n}`,
          collapsedStepsLabel: (n, total) => `단계 ${n}/${total}`,
          cancelButton: "취소",
          previousButton: "이전",
          nextButton: "다음",
          submitButton: "업로드 실행",
          optional: "선택사항",
        }}
        activeStepIndex={activeStepIndex}
        isLoadingNextStep={uploading}
        onNavigate={({ detail }) => {
          // Only validate when moving forward
          if (detail.requestedStepIndex > activeStepIndex) {
            if (!validateStep(activeStepIndex)) return;
          }
          setActiveStepIndex(detail.requestedStepIndex);
        }}
        onSubmit={handleUpload}
        onCancel={() => router.push("/graph")}
        steps={[
          {
            title: "파일 업로드",
            description: "그래프로 변환할 JSON 데이터 파일을 업로드합니다.",
            content: (
              <FileUploadStep
                rawData={rawData}
                fileName={fileName}
                onFileLoad={handleFileLoad}
                selectedSchema={selectedSchema}
                onSchemaSelect={handleSchemaSelect}
              />
            ),
          },
          {
            title: "노드 디자인",
            description:
              "생성할 노드의 타입과 속성 매핑을 설정합니다.",
            content: rawData ? (
              <NodeDesignStep
                jsonFields={jsonFields}
                sampleData={rawData.slice(0, 5)}
                nodeDesign={nodeDesign}
                onChange={setNodeDesign}
              />
            ) : (
              <Alert type="warning">먼저 파일을 업로드하세요.</Alert>
            ),
          },
          {
            title: "엣지 매핑",
            description: "노드 간 관계(엣지)를 설정합니다.",
            isOptional: true,
            content: rawData ? (
              <EdgeMappingStep
                jsonFields={jsonFields}
                edgeMappings={edgeMappings}
                onChange={setEdgeMappings}
                nodeLabel={nodeDesign.nodeLabel}
              />
            ) : (
              <Alert type="warning">먼저 파일을 업로드하세요.</Alert>
            ),
          },
          {
            title: "미리보기 & 검증",
            description: "업로드할 데이터를 확인하고 중복을 검사합니다.",
            content: rawData ? (
              <PreviewStep
                rawData={rawData}
                nodeDesign={nodeDesign}
                edgeMappings={edgeMappings.filter(
                  (r) => r.sourceField && r.targetNodeLabel && r.edgeLabel
                )}
                duplicateStrategy={duplicateStrategy}
                onDuplicateStrategyChange={setDuplicateStrategy}
              />
            ) : (
              <Alert type="warning">먼저 파일을 업로드하세요.</Alert>
            ),
          },
          {
            title: "업로드 실행",
            description: "설정을 확인하고 Neptune에 데이터를 업로드합니다.",
            content: rawData ? (
              <UploadStep
                rawData={rawData}
                nodeDesign={nodeDesign}
                edgeMappings={edgeMappings.filter(
                  (r) => r.sourceField && r.targetNodeLabel && r.edgeLabel
                )}
                duplicateStrategy={duplicateStrategy}
                uploading={uploading}
                uploadResult={uploadResult}
              />
            ) : (
              <Alert type="warning">먼저 파일을 업로드하세요.</Alert>
            ),
          },
        ]}
      />
    </SpaceBetween>
  );
}
