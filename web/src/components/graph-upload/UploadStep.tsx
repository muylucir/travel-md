"use client";

import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import ProgressBar from "@cloudscape-design/components/progress-bar";
import Alert from "@cloudscape-design/components/alert";
import Link from "@cloudscape-design/components/link";
import type {
  NodeDesignConfig,
  EdgeMappingRule,
  DuplicateStrategy,
  UploadResult,
} from "./types";

interface UploadStepProps {
  rawData: Record<string, unknown>[];
  nodeDesign: NodeDesignConfig;
  edgeMappings: EdgeMappingRule[];
  duplicateStrategy: DuplicateStrategy;
  uploading: boolean;
  uploadResult: UploadResult | null;
  useBulk?: boolean;
  bulkStatus?: string | null;
}

const STRATEGY_LABELS: Record<DuplicateStrategy, string> = {
  skip: "건너뛰기",
  update: "업데이트",
  create: "새로 생성",
};

const BULK_STATUS_LABELS: Record<string, { label: string; type: "loading" | "success" | "error" | "info" }> = {
  CONVERTING: { label: "CSV 변환 및 S3 업로드 중...", type: "loading" },
  LOAD_IN_PROGRESS: { label: "Neptune Bulk Loader 실행 중...", type: "loading" },
  LOAD_COMPLETED: { label: "벌크 로딩 완료", type: "success" },
  LOAD_FAILED: { label: "벌크 로딩 실패", type: "error" },
  LOAD_CANCELLED: { label: "벌크 로딩 취소됨", type: "error" },
  TIMEOUT: { label: "상태 조회 시간 초과", type: "error" },
  ERROR: { label: "오류 발생", type: "error" },
};

export default function UploadStep({
  rawData,
  nodeDesign,
  edgeMappings,
  duplicateStrategy,
  uploading,
  uploadResult,
  useBulk,
  bulkStatus,
}: UploadStepProps) {
  if (uploadResult) {
    const hasErrors = uploadResult.errors.length > 0;
    const totalNodes =
      uploadResult.nodesCreated +
      uploadResult.nodesUpdated +
      uploadResult.nodesSkipped;

    return (
      <SpaceBetween size="l">
        <Alert type={hasErrors ? "warning" : "success"}>
          {hasErrors
            ? `업로드가 완료되었지만 ${uploadResult.errors.length}개의 오류가 있습니다.`
            : "업로드가 성공적으로 완료되었습니다!"}
        </Alert>

        <Container header={<Header variant="h2">업로드 결과</Header>}>
          <ColumnLayout columns={3} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">생성된 노드</Box>
              <Box variant="awsui-value-large">
                {uploadResult.nodesCreated.toLocaleString()}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">업데이트된 노드</Box>
              <Box variant="awsui-value-large">
                {uploadResult.nodesUpdated.toLocaleString()}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">건너뛴 노드</Box>
              <Box variant="awsui-value-large">
                {uploadResult.nodesSkipped.toLocaleString()}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">생성된 엣지</Box>
              <Box variant="awsui-value-large">
                {uploadResult.edgesCreated.toLocaleString()}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">자동 생성된 대상 노드</Box>
              <Box variant="awsui-value-large">
                {uploadResult.targetNodesCreated.toLocaleString()}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">소요 시간</Box>
              <Box variant="awsui-value-large">
                {(uploadResult.durationMs / 1000).toFixed(1)}초
              </Box>
            </div>
          </ColumnLayout>
        </Container>

        <ProgressBar
          value={100}
          status="success"
          description={`${totalNodes}건 처리 완료`}
          label="업로드 진행률"
        />

        {hasErrors && (
          <Container header={<Header variant="h2">오류 목록</Header>}>
            <SpaceBetween size="xs">
              {uploadResult.errors.slice(0, 20).map((err, i) => (
                <StatusIndicator key={i} type="error">
                  {err}
                </StatusIndicator>
              ))}
              {uploadResult.errors.length > 20 && (
                <Box color="text-body-secondary">
                  ... 외 {uploadResult.errors.length - 20}개 오류
                </Box>
              )}
            </SpaceBetween>
          </Container>
        )}

        <Box textAlign="center">
          <Link href="/graph" fontSize="heading-m">
            그래프 탐색기에서 확인
          </Link>
        </Box>
      </SpaceBetween>
    );
  }

  if (uploading) {
    const bulkInfo = bulkStatus ? BULK_STATUS_LABELS[bulkStatus] : null;

    return (
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">업로드 진행 중</Header>}>
          <SpaceBetween size="m">
            {useBulk && (
              <Alert type="info">
                <strong>Neptune Bulk Loader</strong> 사용 중 —{" "}
                {rawData.length.toLocaleString()}건 대용량 데이터를 고속 로딩합니다.
              </Alert>
            )}
            <ProgressBar
              status="in-progress"
              label={bulkInfo?.label || "업로드 진행 중..."}
              description={
                useBulk
                  ? "JSON → CSV 변환 → S3 업로드 → Neptune Bulk Loader 실행"
                  : "Neptune 그래프 DB에 데이터를 업로드하고 있습니다."
              }
            />
            <StatusIndicator type={bulkInfo?.type || "loading"}>
              {bulkInfo?.label ||
                `${rawData.length.toLocaleString()}건의 데이터를 처리하고 있습니다...`}
            </StatusIndicator>
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    );
  }

  // Pre-upload summary
  const includedFields = nodeDesign.propertyMappings.filter((m) => m.include);

  return (
    <SpaceBetween size="l">
      {useBulk ? (
        <Alert type="info">
          <strong>{rawData.length.toLocaleString()}건</strong> 대용량 데이터 감지 —{" "}
          <strong>Neptune Bulk Loader</strong>를 사용하여 고속 업로드합니다.
          (JSON → CSV 변환 → S3 → Neptune Loader API)
        </Alert>
      ) : (
        <Alert type="info">
          아래 설정을 확인한 후 &quot;업로드 실행&quot; 버튼을 클릭하세요.
          업로드가 시작되면 취소할 수 없습니다.
        </Alert>
      )}

      <Container header={<Header variant="h2">업로드 요약</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <SpaceBetween size="s">
            <div>
              <Box variant="awsui-key-label">노드 타입</Box>
              <div>{nodeDesign.nodeLabel}</div>
            </div>
            <div>
              <Box variant="awsui-key-label">ID 필드</Box>
              <div>{nodeDesign.idField}</div>
            </div>
            <div>
              <Box variant="awsui-key-label">총 레코드 수</Box>
              <div>{rawData.length.toLocaleString()}건</div>
            </div>
            <div>
              <Box variant="awsui-key-label">포함 속성</Box>
              <div>
                {includedFields.map((m) => m.nodeProperty).join(", ")}
              </div>
            </div>
          </SpaceBetween>
          <SpaceBetween size="s">
            <div>
              <Box variant="awsui-key-label">엣지 규칙</Box>
              <div>
                {edgeMappings.length === 0
                  ? "없음"
                  : edgeMappings
                      .map(
                        (r) =>
                          `${r.sourceField} → ${r.targetNodeLabel} (${r.edgeLabel})`
                      )
                      .join(", ")}
              </div>
            </div>
            <div>
              <Box variant="awsui-key-label">중복 처리</Box>
              <div>{STRATEGY_LABELS[duplicateStrategy]}</div>
            </div>
          </SpaceBetween>
        </ColumnLayout>
      </Container>
    </SpaceBetween>
  );
}
