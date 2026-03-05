"use client";

import { useState, useCallback } from "react";
import { fetchSSE } from "@/lib/sse-client";
import type { PlanningInput, PlanningOutput, ProgressData } from "@/lib/types";

export type PlanningStatus = "idle" | "running" | "done" | "error";

export interface UsePlanningReturn {
  status: PlanningStatus;
  progress: ProgressData;
  result: PlanningOutput | null;
  error: string | null;
  startPlanning: (input: PlanningInput) => Promise<void>;
  reset: () => void;
}

export function usePlanning(): UsePlanningReturn {
  const [status, setStatus] = useState<PlanningStatus>("idle");
  const [progress, setProgress] = useState<ProgressData>({
    step: "",
    percent: 0,
  });
  const [result, setResult] = useState<PlanningOutput | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startPlanning = useCallback(async (input: PlanningInput) => {
    setStatus("running");
    setProgress({ step: "요청 전송 중...", percent: 0 });
    setResult(null);
    setError(null);

    try {
      await fetchSSE("/api/planning", input, {
        onProgress: (data) => {
          setProgress(data);
        },
        onResult: (data) => {
          setResult(data);
          setStatus("done");
          setProgress({ step: "완료", percent: 100 });
        },
        onError: (errMsg) => {
          setError(errMsg);
          setStatus("error");
        },
      });

      // If stream ended without a result or error event
      setStatus((prev) => (prev === "running" ? "done" : prev));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
      setError(message);
      setStatus("error");
    }
  }, []);

  const reset = useCallback(() => {
    setStatus("idle");
    setProgress({ step: "", percent: 0 });
    setResult(null);
    setError(null);
  }, []);

  return { status, progress, result, error, startPlanning, reset };
}
