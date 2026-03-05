"use client";

import { useState, useCallback, useRef } from "react";
import { fetchSSE } from "@/lib/sse-client";
import type {
  PlanningOutput,
  ProgressData,
  ChatMessage,
} from "@/lib/types";

export type PlanningStatus = "idle" | "running" | "done" | "error";

const WELCOME_MESSAGE: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "안녕하세요! 여행 상품 기획을 도와드리겠습니다.\n\n" +
    "패키지 검색, 상세 조회, 비교 등을 자유롭게 요청하세요.\n" +
    "기획을 원하시면 \"기획해줘\"라고 말씀해주세요.\n\n" +
    "예시:\n" +
    "- \"간사이 인기 패키지 3개 뽑아줘\"\n" +
    "- \"JOP131260401TWN 상세 보여줘\"\n" +
    "- \"이거 기반으로 유사도 80% 가족여행으로 기획해줘\"",
  timestamp: new Date(),
};

const MAX_HISTORY = 20;

export interface UseChatReturn {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingText: string;
  toolStatus: string;
  planningResult: PlanningOutput | null;
  planningProgress: ProgressData;
  planningStatus: PlanningStatus;
  sendMessage: (text: string) => Promise<void>;
  reset: () => void;
}

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MESSAGE]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [toolStatus, setToolStatus] = useState("");
  const [planningResult, setPlanningResult] = useState<PlanningOutput | null>(null);
  const [planningProgress, setPlanningProgress] = useState<ProgressData>({ step: "", percent: 0 });
  const [planningStatus, setPlanningStatus] = useState<PlanningStatus>("idle");

  // Use ref for streaming text accumulation to avoid stale closures
  const streamRef = useRef("");

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isLoading) return;

      // Add user message
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmed,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);
      setStreamingText("");
      setToolStatus("");
      setPlanningStatus("idle");
      setPlanningProgress({ step: "", percent: 0 });
      streamRef.current = "";

      // Build history (exclude welcome message, limit to MAX_HISTORY)
      const currentMessages = [...messages, userMsg];
      const history = currentMessages
        .filter((m) => m.id !== "welcome")
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, content: m.content }));

      try {
        await fetchSSE(
          "/api/planning",
          { mode: "chat", message: trimmed, history },
          {
            onMessageChunk: (data) => {
              streamRef.current += data.chunk;
              setStreamingText(streamRef.current);
            },
            onMessageComplete: (data) => {
              const content = data.content || streamRef.current;
              const assistantMsg: ChatMessage = {
                id: `asst-${Date.now()}`,
                role: "assistant",
                content,
                timestamp: new Date(),
              };
              setMessages((prev) => [...prev, assistantMsg]);
              setStreamingText("");
              setToolStatus("");
              setIsLoading(false);
            },
            onToolUse: (data) => {
              setToolStatus(data.tool);
            },
            onProgress: (data) => {
              setPlanningProgress(data);
              setPlanningStatus("running");
            },
            onResult: (data) => {
              setPlanningResult(data);
              setPlanningStatus("done");
              setIsLoading(false);
            },
            onError: (errMsg) => {
              const errorMsg: ChatMessage = {
                id: `err-${Date.now()}`,
                role: "assistant",
                content: `오류가 발생했습니다: ${errMsg}`,
                timestamp: new Date(),
              };
              setMessages((prev) => [...prev, errorMsg]);
              setStreamingText("");
              setToolStatus("");
              setIsLoading(false);
            },
          }
        );

        // If stream ended without message_complete (e.g., only planning events)
        setIsLoading(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : "알 수 없는 오류";
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: "assistant",
            content: `오류: ${message}`,
            timestamp: new Date(),
          },
        ]);
        setIsLoading(false);
      }
    },
    [messages, isLoading]
  );

  const reset = useCallback(() => {
    setMessages([WELCOME_MESSAGE]);
    setIsLoading(false);
    setStreamingText("");
    setToolStatus("");
    setPlanningResult(null);
    setPlanningProgress({ step: "", percent: 0 });
    setPlanningStatus("idle");
    streamRef.current = "";
  }, []);

  return {
    messages,
    isLoading,
    streamingText,
    toolStatus,
    planningResult,
    planningProgress,
    planningStatus,
    sendMessage,
    reset,
  };
}
