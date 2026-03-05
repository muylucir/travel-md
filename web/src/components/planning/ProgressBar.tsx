"use client";

import CloudscapeProgressBar from "@cloudscape-design/components/progress-bar";
import Alert from "@cloudscape-design/components/alert";
import Container from "@cloudscape-design/components/container";
import type { PlanningStatus } from "@/hooks/usePlanning";

const STEP_LABELS: Record<string, string> = {
  parse_input: "입력 파싱",
  parsing: "입력 파싱",
  collect_context: "컨텍스트 수집",
  collecting: "컨텍스트 수집",
  generate_itinerary: "일정 생성",
  generating: "일정 생성",
  validate_itinerary: "일정 검증",
  validating: "일정 검증",
  complete: "완료",
};

interface ProgressBarProps {
  status: PlanningStatus;
  step: string;
  percent: number;
  errorMessage?: string;
}

export default function ProgressBar({
  status,
  step,
  percent,
  errorMessage,
}: ProgressBarProps) {
  if (status === "error" && errorMessage) {
    return (
      <Alert type="error" header="기획 오류">
        {errorMessage}
      </Alert>
    );
  }

  const displayStep = STEP_LABELS[step] || step || "준비 중...";
  const clampedPercent = Math.min(100, Math.max(0, percent));

  return (
    <Container>
      <CloudscapeProgressBar
        value={clampedPercent}
        label="상품 기획 진행 중"
        description={displayStep}
        status={status === "done" ? "success" : "in-progress"}
        resultText="기획이 완료되었습니다!"
      />
    </Container>
  );
}
