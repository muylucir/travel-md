"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Container from "@cloudscape-design/components/container";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Textarea from "@cloudscape-design/components/textarea";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import ProgressBar from "@cloudscape-design/components/progress-bar";
import type { ChatMessage, ProgressData } from "@/lib/types";
import type { PlanningStatus } from "@/hooks/useChat";

interface ChatModeProps {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingText: string;
  toolStatus: string;
  planningStatus: PlanningStatus;
  planningProgress: ProgressData;
  onSend: (text: string) => void;
  onReset: () => void;
}

export default function ChatMode({
  messages,
  isLoading,
  streamingText,
  toolStatus,
  planningStatus,
  planningProgress,
  onSend,
  onReset,
}: ChatModeProps) {
  const [inputText, setInputText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingText, scrollToBottom]);

  const handleSend = () => {
    const text = inputText.trim();
    if (!text || isLoading) return;
    onSend(text);
    setInputText("");
  };

  const handleKeyDown = (event: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <Container
      header={
        <Box float="right">
          <Button onClick={onReset} variant="link" iconName="refresh">
            새 대화
          </Button>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {/* Message area */}
        <div style={{ maxHeight: 600, overflowY: "auto", padding: "8px 0" }}>
          <SpaceBetween size="s">
            {messages.map((msg) => (
              <ChatBubble key={msg.id} message={msg} />
            ))}

            {/* Streaming text (typing indicator) */}
            {streamingText && (
              <ChatBubble
                message={{
                  id: "streaming",
                  role: "assistant",
                  content: streamingText,
                  timestamp: new Date(),
                }}
                isStreaming
              />
            )}

            {/* Tool use status */}
            {toolStatus && (
              <div style={{ padding: "4px 16px" }}>
                <StatusIndicator type="loading">
                  {toolStatus} 조회 중...
                </StatusIndicator>
              </div>
            )}

            {/* Planning progress */}
            {planningStatus === "running" && (
              <div style={{ padding: "8px 16px" }}>
                <ProgressBar
                  value={planningProgress.percent}
                  label="상품 기획 중"
                  description={planningProgress.step}
                />
              </div>
            )}

            <div ref={messagesEndRef} />
          </SpaceBetween>
        </div>

        {/* Input area */}
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }} onKeyDown={handleKeyDown}>
          <div style={{ flex: 1 }}>
            <Textarea
              value={inputText}
              onChange={({ detail }) => setInputText(detail.value)}
              placeholder="여행 정보 검색이나 기획 요청을 입력하세요... (Enter로 전송)"
              rows={2}
              disabled={isLoading}
            />
          </div>
          <Button
            variant="primary"
            onClick={handleSend}
            disabled={isLoading}
            loading={isLoading}
            iconName="send"
          >
            전송
          </Button>
        </div>
      </SpaceBetween>
    </Container>
  );
}

function ChatBubble({ message, isStreaming }: { message: ChatMessage; isStreaming?: boolean }) {
  const isUser = message.role === "user";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        padding: "4px 0",
      }}
    >
      <div
        style={{
          maxWidth: "85%",
          padding: "12px 16px",
          borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
          backgroundColor: isUser ? "#0972d3" : "#f2f3f3",
          color: isUser ? "#ffffff" : "#000716",
          whiteSpace: "pre-wrap",
          lineHeight: 1.6,
          fontSize: 14,
        }}
      >
        <Box variant="small" color={isUser ? "inherit" : "text-body-secondary"}>
          {isUser ? "MD" : "AI 기획 어시스턴트"}
          {isStreaming && " ●"}
        </Box>
        <div style={{ marginTop: 4 }}>{message.content}</div>
      </div>
    </div>
  );
}
