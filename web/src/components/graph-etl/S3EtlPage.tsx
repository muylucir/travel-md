"use client";

import { useState, useCallback, useRef } from "react";
import yaml from "js-yaml";
import Header from "@cloudscape-design/components/header";
import Container from "@cloudscape-design/components/container";
import SpaceBetween from "@cloudscape-design/components/space-between";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Button from "@cloudscape-design/components/button";
import Table from "@cloudscape-design/components/table";
import Textarea from "@cloudscape-design/components/textarea";
import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Modal from "@cloudscape-design/components/modal";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Tabs from "@cloudscape-design/components/tabs";
import PreviewStep from "@/components/graph-upload/PreviewStep";
import UploadStep from "@/components/graph-upload/UploadStep";
import type {
  NodeDesignConfig,
  EdgeMappingRule,
  DuplicateStrategy,
  UploadResult,
} from "@/components/graph-upload/types";
import {
  validateMappingRule,
  getDefaultMappingRule,
} from "@/lib/mapping-rule";

// ─── 예제 템플릿 ───

const JSON_EXAMPLE = `{
  "name": "restaurant-to-graph",
  "description": "RDBMS restaurants 테이블 → Graph 변환",
  "source_vertex": {
    "label": "Restaurant",
    "id_field": "restaurant_id",
    "properties": {
      "name":    { "from": "name",         "type": "string" },
      "cuisine": { "from": "cuisine_type", "type": "string" },
      "rating":  { "from": "avg_rating",   "type": "number" },
      "address": { "from": "full_address", "type": "string" }
    }
  },
  "edges": [
    {
      "label": "LOCATED_IN",
      "direction": "out",
      "source_field": "city_name",
      "target": {
        "label": "City",
        "match_by": "name",
        "auto_create": false
      }
    },
    {
      "label": "SERVES",
      "direction": "out",
      "source_field": "cuisine_type",
      "target": {
        "label": "Cuisine",
        "match_by": "name",
        "auto_create": true
      }
    }
  ],
  "options": {
    "duplicate_strategy": "update",
    "batch_size": 100
  }
}`;

const YAML_EXAMPLE = `name: restaurant-to-graph
description: RDBMS restaurants 테이블 → Graph 변환

source_vertex:
  label: Restaurant
  id_field: restaurant_id
  properties:
    name:
      from: name
      type: string
    cuisine:
      from: cuisine_type
      type: string
    rating:
      from: avg_rating
      type: number
    address:
      from: full_address
      type: string

edges:
  - label: LOCATED_IN
    direction: out
    source_field: city_name
    target:
      label: City
      match_by: name
      auto_create: false

  - label: SERVES
    direction: out
    source_field: cuisine_type
    target:
      label: Cuisine
      match_by: name
      auto_create: true

options:
  duplicate_strategy: update
  batch_size: 100`;

const codeStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
  fontSize: 13,
  lineHeight: 1.5,
  backgroundColor: "#0f1b2d",
  color: "#d1d5db",
  padding: 16,
  borderRadius: 8,
  overflow: "auto",
  whiteSpace: "pre",
  maxHeight: 400,
};

interface S3ObjectInfo {
  key: string;
  size: number;
  lastModified: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export default function S3EtlPage() {
  // ── S3 Source ──
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [s3Objects, setS3Objects] = useState<S3ObjectInfo[]>([]);
  const [s3Prefixes, setS3Prefixes] = useState<string[]>([]);
  const [s3Loading, setS3Loading] = useState(false);
  const [s3Error, setS3Error] = useState<string | null>(null);
  const [s3DataInfo, setS3DataInfo] = useState<{
    totalCount: number;
    fields: string[];
  } | null>(null);

  // ── Mapping Rule ──
  const [mappingRuleText, setMappingRuleText] = useState(
    getDefaultMappingRule()
  );
  const [ruleValidation, setRuleValidation] = useState<{
    valid: boolean;
    errors: string[];
  }>({ valid: true, errors: [] });
  const ruleFileRef = useRef<HTMLInputElement>(null);

  // ── Preview ──
  const [previewData, setPreviewData] = useState<
    Record<string, unknown>[] | null
  >(null);
  const [nodeDesign, setNodeDesign] = useState<NodeDesignConfig | null>(null);
  const [edgeMappings, setEdgeMappings] = useState<EdgeMappingRule[]>([]);
  const [duplicateStrategy, setDuplicateStrategy] =
    useState<DuplicateStrategy>("skip");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [totalRecordCount, setTotalRecordCount] = useState(0);
  const [csvStats, setCsvStats] = useState<{
    primaryNodes: number;
    targetNodes: number;
    edges: number;
  } | null>(null);

  // ── Upload ──
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [useBulk, setUseBulk] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);
  const [confirmVisible, setConfirmVisible] = useState(false);

  // ── S3 탐색 ──
  const browseS3 = useCallback(async () => {
    if (!bucket) return;
    setS3Loading(true);
    setS3Error(null);
    setS3Objects([]);
    setS3Prefixes([]);
    setSelectedKey("");
    setS3DataInfo(null);

    try {
      const params = new URLSearchParams({ bucket, prefix });
      const res = await fetch(`/api/s3/list?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "S3 목록 조회 실패");
      setS3Prefixes(json.prefixes || []);
      setS3Objects(json.objects || []);
    } catch (err) {
      setS3Error(
        err instanceof Error ? err.message : "S3 목록 조회에 실패했습니다."
      );
    } finally {
      setS3Loading(false);
    }
  }, [bucket, prefix]);

  const navigatePrefix = useCallback(
    (newPrefix: string) => {
      setPrefix(newPrefix);
      setSelectedKey("");
      setS3DataInfo(null);
      // 자동 탐색
      setTimeout(async () => {
        setS3Loading(true);
        setS3Error(null);
        try {
          const params = new URLSearchParams({ bucket, prefix: newPrefix });
          const res = await fetch(`/api/s3/list?${params}`);
          const json = await res.json();
          if (!res.ok) throw new Error(json.error);
          setS3Prefixes(json.prefixes || []);
          setS3Objects(json.objects || []);
        } catch (err) {
          setS3Error(
            err instanceof Error ? err.message : "S3 탐색 실패"
          );
        } finally {
          setS3Loading(false);
        }
      }, 0);
    },
    [bucket]
  );

  // 파일 선택 시 메타데이터 확인
  const selectS3Object = useCallback(
    async (key: string) => {
      setSelectedKey(key);
      setS3DataInfo(null);
      try {
        const params = new URLSearchParams({ bucket, key, limit: "5" });
        const res = await fetch(`/api/s3/preview?${params}`);
        const json = await res.json();
        if (res.ok) {
          setS3DataInfo({ totalCount: json.totalCount, fields: json.fields });
        }
      } catch {
        // 미리보기 실패는 무시 (선택은 유지)
      }
    },
    [bucket]
  );

  // ── 매핑 룰 편집 ──
  const parseRuleText = useCallback((text: string): unknown | null => {
    // JSON 시도
    try {
      return JSON.parse(text);
    } catch {
      // YAML 시도
      try {
        return yaml.load(text);
      } catch {
        return null;
      }
    }
  }, []);

  const handleRuleChange = useCallback(
    (value: string) => {
      setMappingRuleText(value);
      const parsed = parseRuleText(value);
      if (parsed === null) {
        setRuleValidation({
          valid: false,
          errors: ["유효한 JSON 또는 YAML이 아닙니다."],
        });
      } else {
        setRuleValidation(validateMappingRule(parsed));
      }
    },
    [parseRuleText]
  );

  const handleRuleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        const isYaml = file.name.endsWith(".yaml") || file.name.endsWith(".yml");

        if (isYaml) {
          // YAML → JSON 변환하여 에디터에 표시
          try {
            const parsed = yaml.load(text);
            const jsonText = JSON.stringify(parsed, null, 2);
            setMappingRuleText(jsonText);
            setRuleValidation(validateMappingRule(parsed));
          } catch {
            setMappingRuleText(text);
            setRuleValidation({
              valid: false,
              errors: ["유효한 YAML이 아닙니다."],
            });
          }
        } else {
          setMappingRuleText(text);
          try {
            const parsed = JSON.parse(text);
            setRuleValidation(validateMappingRule(parsed));
          } catch {
            setRuleValidation({
              valid: false,
              errors: ["유효한 JSON이 아닙니다."],
            });
          }
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    []
  );

  const resetToTemplate = useCallback(() => {
    const template = getDefaultMappingRule();
    setMappingRuleText(template);
    setRuleValidation({ valid: true, errors: [] });
  }, []);

  // ── 미리보기 실행 ──
  const runPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewWarnings([]);
    setPreviewData(null);
    setNodeDesign(null);
    setCsvStats(null);

    try {
      const mappingRule = parseRuleText(mappingRuleText);
      if (!mappingRule) throw new Error("매핑 룰 파싱에 실패했습니다.");
      const res = await fetch("/api/graph/etl/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket,
          key: selectedKey,
          mappingRule,
          limit: 200,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(
          json.error +
            (json.details ? "\n" + json.details.join("\n") : "")
        );
      }

      setPreviewData(json.data);
      setNodeDesign(json.nodeDesign);
      setEdgeMappings(json.edgeMappings);
      setDuplicateStrategy(json.duplicateStrategy);
      setTotalRecordCount(json.totalCount);
      setCsvStats(json.csvStats);
      setPreviewWarnings(json.warnings || []);

      // Bulk 여부 판단 (기본 100건 이상이면 Bulk Loader)
      const rule = mappingRule as Record<string, unknown>;
      const opts = (rule.options ?? {}) as Record<string, unknown>;
      const batchSize = (opts.batch_size as number) ?? 100;
      setUseBulk(json.totalCount >= batchSize);
    } catch (err) {
      setPreviewError(
        err instanceof Error ? err.message : "미리보기 실행에 실패했습니다."
      );
    } finally {
      setPreviewLoading(false);
    }
  }, [bucket, selectedKey, mappingRuleText]);

  // ── 적재 실행 ──
  const executeUpload = useCallback(async () => {
    setConfirmVisible(false);
    setUploading(true);
    setUploadResult(null);
    setBulkStatus(null);

    try {
      const mappingRule = parseRuleText(mappingRuleText);
      if (!mappingRule) throw new Error("매핑 룰 파싱에 실패했습니다.");

      if (useBulk) {
        // Bulk Loader 경로
        setBulkStatus("CONVERTING");
        const res = await fetch("/api/graph/etl/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, key: selectedKey, mappingRule }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error);

        if (json.mode === "bulk" && json.loadId) {
          setBulkStatus("LOAD_IN_PROGRESS");
          // 폴링
          await pollBulkStatus(json.loadId);
        } else {
          // Gremlin 결과
          setUploadResult(json);
        }
      } else {
        // Gremlin 경로
        const res = await fetch("/api/graph/etl/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket, key: selectedKey, mappingRule }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error);
        setUploadResult({
          nodesCreated: json.nodesCreated || 0,
          nodesSkipped: json.nodesSkipped || 0,
          nodesUpdated: json.nodesUpdated || 0,
          edgesCreated: json.edgesCreated || 0,
          edgesSkipped: json.edgesSkipped || 0,
          targetNodesCreated: json.targetNodesCreated || 0,
          errors: json.errors || [],
          durationMs: json.durationMs || 0,
        });
      }
    } catch (err) {
      setUploadResult({
        nodesCreated: 0,
        nodesSkipped: 0,
        nodesUpdated: 0,
        edgesCreated: 0,
        edgesSkipped: 0,
        targetNodesCreated: 0,
        errors: [
          err instanceof Error ? err.message : "적재에 실패했습니다.",
        ],
        durationMs: 0,
      });
    } finally {
      setUploading(false);
    }
  }, [bucket, selectedKey, mappingRuleText, useBulk]);

  const pollBulkStatus = async (loadId: string) => {
    const MAX_POLLS = 120; // 10분 (5초 × 120)
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const res = await fetch(`/api/graph/upload/bulk/${loadId}`);
        const json = await res.json();
        const status = json.status || "UNKNOWN";
        setBulkStatus(status);

        if (
          ["LOAD_COMPLETED", "LOAD_FAILED", "LOAD_CANCELLED", "ERROR"].includes(
            status
          )
        ) {
          setUploadResult({
            nodesCreated: json.totalRecords || 0,
            nodesSkipped: json.totalDuplicates || 0,
            nodesUpdated: 0,
            edgesCreated: 0,
            edgesSkipped: 0,
            targetNodesCreated: 0,
            errors: json.errors || [],
            durationMs: json.totalTimeMillis || 0,
          });
          return;
        }
      } catch {
        setBulkStatus("ERROR");
        return;
      }
    }
    setBulkStatus("TIMEOUT");
  };

  const canPreview =
    bucket.trim() !== "" &&
    selectedKey !== "" &&
    ruleValidation.valid &&
    mappingRuleText.trim() !== "";

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="S3의 JSON 데이터를 매핑 룰에 따라 Neptune 그래프로 변환합니다."
      >
        S3 → Graph 변환
      </Header>

      {/* ── 사용방법 (접힘) ── */}
      <ExpandableSection
        headerText="사용방법"
        variant="container"
        defaultExpanded={false}
      >
        <SpaceBetween size="m">
          <Box variant="p">
            RDBMS에서 추출한 JSON 데이터를 S3에 올려두고, 매핑 룰 문서로
            그래프 변환 규칙을 정의하면 Neptune에 적재할 수 있습니다.
          </Box>

          <Header variant="h3">순서</Header>
          <Box variant="p">
            1. <strong>S3 데이터 소스</strong>에서 버킷과 경로를 입력하고
            JSON 파일을 선택합니다.
            <br />
            2. <strong>매핑 룰</strong>에 JSON 또는 YAML 파일을 업로드하거나
            직접 편집합니다.
            <br />
            3. <strong>미리보기 실행</strong>을 눌러 변환 결과를 확인합니다.
            (데이터 테이블, 그래프 시각화, 통계)
            <br />
            4. 결과가 만족스러우면 <strong>Neptune에 적재</strong>을 눌러
            실제로 적재합니다.
            <br />
            &nbsp;&nbsp;&nbsp;&nbsp;- 기존 동일 label의 vertex와 edge는 자동
            삭제 후 새로 적재됩니다.
            <br />
            &nbsp;&nbsp;&nbsp;&nbsp;- 100건 이상이면 Bulk Loader, 미만이면
            Gremlin으로 적재됩니다.
          </Box>

          <Header variant="h3">매핑 룰 구조</Header>
          <Box variant="p">
            매핑 룰은 JSON 또는 YAML로 작성할 수 있습니다. YAML 파일을
            업로드하면 자동으로 JSON으로 변환됩니다.
          </Box>

          <Table
            variant="embedded"
            columnDefinitions={[
              { id: "field", header: "필드", cell: (r) => <strong>{r.field}</strong>, width: 200 },
              { id: "required", header: "필수", cell: (r) => r.required, width: 60 },
              { id: "desc", header: "설명", cell: (r) => r.desc },
            ]}
            items={[
              { field: "name", required: "O", desc: "매핑 룰 이름" },
              { field: "description", required: "", desc: "설명 (선택)" },
              { field: "source_vertex.label", required: "O", desc: "생성할 vertex의 label (예: Restaurant)" },
              { field: "source_vertex.id_field", required: "O", desc: "JSON에서 vertex ID로 사용할 필드명" },
              { field: "source_vertex.properties", required: "O", desc: "{ nodeProperty: { from: jsonField, type: string|number|boolean|json } }" },
              { field: "edges[].label", required: "O", desc: "edge label (예: LOCATED_IN)" },
              { field: "edges[].direction", required: "O", desc: "out (소스→타겟) 또는 in (타겟→소스)" },
              { field: "edges[].source_field", required: "O", desc: "edge 연결에 사용할 JSON 필드명" },
              { field: "edges[].target", required: "O", desc: "{ label, match_by, auto_create } — 연결할 대상 vertex 정보" },
              { field: "options.duplicate_strategy", required: "", desc: "skip / update / create (기본: skip)" },
              { field: "options.batch_size", required: "", desc: "Bulk Loader 전환 기준 (기본: 100)" },
            ]}
          />

          <Header variant="h3">예제</Header>
          <Tabs
            tabs={[
              {
                label: "JSON",
                id: "json-example",
                content: (
                  <div style={codeStyle}>{JSON_EXAMPLE}</div>
                ),
              },
              {
                label: "YAML",
                id: "yaml-example",
                content: (
                  <div style={codeStyle}>{YAML_EXAMPLE}</div>
                ),
              },
            ]}
          />
        </SpaceBetween>
      </ExpandableSection>

      {/* ── S3 데이터 소스 ── */}
      <Container header={<Header variant="h2">S3 데이터 소스</Header>}>
        <SpaceBetween size="m">
          <ColumnLayout columns={3}>
            <FormField label="Bucket">
              <Input
                value={bucket}
                onChange={({ detail }) => setBucket(detail.value)}
                placeholder="my-data-bucket"
              />
            </FormField>
            <FormField label="Prefix (경로)">
              <Input
                value={prefix}
                onChange={({ detail }) => setPrefix(detail.value)}
                placeholder="exports/restaurants/"
              />
            </FormField>
            <FormField label="&nbsp;">
              <Button
                onClick={browseS3}
                loading={s3Loading}
                disabled={!bucket}
              >
                탐색
              </Button>
            </FormField>
          </ColumnLayout>

          {s3Error && <Alert type="error">{s3Error}</Alert>}

          {/* 폴더 네비게이션 */}
          {s3Prefixes.length > 0 && (
            <SpaceBetween size="xs" direction="horizontal">
              {prefix && (
                <Button
                  variant="link"
                  onClick={() => {
                    const parts = prefix.replace(/\/$/, "").split("/");
                    parts.pop();
                    navigatePrefix(parts.length > 0 ? parts.join("/") + "/" : "");
                  }}
                >
                  .. (상위)
                </Button>
              )}
              {s3Prefixes.map((p) => (
                <Button
                  key={p}
                  variant="link"
                  onClick={() => navigatePrefix(p)}
                >
                  {p.replace(prefix, "").replace(/\/$/, "")}/
                </Button>
              ))}
            </SpaceBetween>
          )}

          {/* 파일 목록 */}
          {s3Objects.length > 0 && (
            <Table
              items={s3Objects}
              selectionType="single"
              selectedItems={s3Objects.filter((o) => o.key === selectedKey)}
              onSelectionChange={({ detail }) => {
                const item = detail.selectedItems[0];
                if (item) selectS3Object(item.key);
              }}
              columnDefinitions={[
                {
                  id: "key",
                  header: "파일",
                  cell: (item) => item.key.replace(prefix, ""),
                  sortingField: "key",
                },
                {
                  id: "size",
                  header: "크기",
                  cell: (item) => formatBytes(item.size),
                  width: 100,
                },
                {
                  id: "lastModified",
                  header: "수정일",
                  cell: (item) =>
                    item.lastModified
                      ? new Date(item.lastModified).toLocaleDateString("ko-KR")
                      : "-",
                  width: 120,
                },
              ]}
              empty={<Box textAlign="center">파일이 없습니다.</Box>}
              variant="embedded"
            />
          )}

          {/* 선택된 파일 정보 */}
          {selectedKey && s3DataInfo && (
            <Alert type="info">
              <strong>{selectedKey.split("/").pop()}</strong> — 총{" "}
              <strong>{s3DataInfo.totalCount.toLocaleString()}건</strong>, 필드:{" "}
              {s3DataInfo.fields.join(", ")}
            </Alert>
          )}
        </SpaceBetween>
      </Container>

      {/* ── 매핑 룰 ── */}
      <Container header={<Header variant="h2">매핑 룰</Header>}>
        <SpaceBetween size="m">
          <SpaceBetween size="xs" direction="horizontal">
            <Button
              iconName="upload"
              onClick={() => ruleFileRef.current?.click()}
            >
              룰 파일 업로드 (.json / .yaml)
            </Button>
            <Button variant="link" onClick={resetToTemplate}>
              기본 템플릿
            </Button>
            <input
              ref={ruleFileRef}
              type="file"
              accept=".json,.yaml,.yml"
              style={{ display: "none" }}
              onChange={handleRuleFileUpload}
            />
          </SpaceBetween>

          <FormField
            description="매핑 룰을 JSON으로 편집하세요. source_vertex, edges, options를 정의합니다."
            errorText={
              !ruleValidation.valid
                ? ruleValidation.errors.join(" / ")
                : undefined
            }
          >
            <Textarea
              value={mappingRuleText}
              onChange={({ detail }) => handleRuleChange(detail.value)}
              rows={20}
              spellcheck={false}
            />
          </FormField>

          {ruleValidation.valid && mappingRuleText.trim() !== "" && (
            <StatusIndicator type="success">
              매핑 룰 검증 통과
            </StatusIndicator>
          )}
        </SpaceBetween>
      </Container>

      {/* ── 미리보기 실행 버튼 ── */}
      <Box>
        <Button
          variant="primary"
          onClick={runPreview}
          loading={previewLoading}
          disabled={!canPreview}
        >
          미리보기 실행
        </Button>
      </Box>

      {previewError && <Alert type="error">{previewError}</Alert>}

      {previewWarnings.length > 0 && (
        <Alert type="warning">
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {previewWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}

      {/* ── 미리보기 결과 ── */}
      {previewData && nodeDesign && (
        <>
          {/* 변환 통계 요약 */}
          {csvStats && (
            <Container header={<Header variant="h2">변환 통계 (샘플 기준)</Header>}>
              <ColumnLayout columns={4} variant="text-grid">
                <div>
                  <Box variant="awsui-key-label">전체 레코드</Box>
                  <Box variant="awsui-value-large">
                    {totalRecordCount.toLocaleString()}건
                  </Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">생성 예정 Vertex</Box>
                  <Box variant="awsui-value-large">
                    {csvStats.primaryNodes.toLocaleString()} +{" "}
                    {csvStats.targetNodes.toLocaleString()} (자동생성)
                  </Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">생성 예정 Edge</Box>
                  <Box variant="awsui-value-large">
                    {csvStats.edges.toLocaleString()}
                  </Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">적재 방식</Box>
                  <Box variant="awsui-value-large">
                    {useBulk ? "Bulk Loader" : "Gremlin"}
                  </Box>
                </div>
              </ColumnLayout>
            </Container>
          )}

          <PreviewStep
            rawData={previewData}
            nodeDesign={nodeDesign}
            edgeMappings={edgeMappings}
            duplicateStrategy={duplicateStrategy}
            onDuplicateStrategyChange={setDuplicateStrategy}
          />

          {/* ── 적재 실행 ── */}
          {!uploadResult && !uploading && (
            <Box>
              <Button
                variant="primary"
                onClick={() => setConfirmVisible(true)}
              >
                Neptune에 적재 ({totalRecordCount.toLocaleString()}건)
              </Button>
            </Box>
          )}

          <Modal
            visible={confirmVisible}
            onDismiss={() => setConfirmVisible(false)}
            header="적재 확인"
            footer={
              <Box float="right">
                <SpaceBetween size="xs" direction="horizontal">
                  <Button
                    variant="link"
                    onClick={() => setConfirmVisible(false)}
                  >
                    취소
                  </Button>
                  <Button variant="primary" onClick={executeUpload}>
                    삭제 후 적재 실행
                  </Button>
                </SpaceBetween>
              </Box>
            }
          >
            <SpaceBetween size="s">
              <Alert type="warning">
                기존 <strong>{nodeDesign.nodeLabel}</strong> vertex와 연결된
                edge가 <strong>모두 삭제</strong>된 후 새 데이터가 적재됩니다.
              </Alert>
              <Box>
                <strong>{totalRecordCount.toLocaleString()}건</strong>의 데이터를{" "}
                {useBulk ? "Bulk Loader" : "Gremlin"}로 Neptune에 적재합니다.
              </Box>
              <Box>
                대상: <strong>{nodeDesign.nodeLabel}</strong> vertex +{" "}
                {edgeMappings.length}개 edge 룰
              </Box>
            </SpaceBetween>
          </Modal>

          {(uploading || uploadResult) && (
            <UploadStep
              rawData={previewData}
              nodeDesign={nodeDesign}
              edgeMappings={edgeMappings}
              duplicateStrategy={duplicateStrategy}
              uploading={uploading}
              uploadResult={uploadResult}
              useBulk={useBulk}
              bulkStatus={bulkStatus}
            />
          )}
        </>
      )}
    </SpaceBetween>
  );
}
