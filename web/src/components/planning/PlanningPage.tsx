"use client";

import { useState } from "react";
import { usePlanning } from "@/hooks/usePlanning";
import { useChat } from "@/hooks/useChat";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Grid from "@cloudscape-design/components/grid";
import Header from "@cloudscape-design/components/header";
import Tabs from "@cloudscape-design/components/tabs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import FormMode from "./FormMode";
import ChatMode from "./ChatMode";
import ResultPanel from "./ResultPanel";
import ProgressBar from "./ProgressBar";
import type { PlanningInput, PlanningOutput } from "@/lib/types";

export default function PlanningPage() {
  // Form mode uses the existing usePlanning hook
  const formPlanning = usePlanning();

  // Chat mode uses the new useChat hook
  const chat = useChat();

  // Track which tab produced the latest result
  const [activeTab, setActiveTab] = useState("chat");

  const handleFormSubmit = (input: PlanningInput) => {
    formPlanning.startPlanning(input);
  };

  // Determine which result to show based on active tab
  const isFormRunning = formPlanning.status === "running";
  const activeResult: PlanningOutput | null =
    activeTab === "form" ? formPlanning.result : chat.planningResult;
  const hasResult = activeResult !== null;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="AI가 Knowledge Graph 기반으로 새로운 여행 패키지 상품 초안을 자동 생성합니다."
          actions={
            hasResult ? (
              <button
                onClick={() => {
                  if (activeTab === "form") formPlanning.reset();
                  else chat.reset();
                }}
                style={{
                  padding: "6px 16px",
                  cursor: "pointer",
                  border: "1px solid #545b64",
                  borderRadius: 4,
                  background: "transparent",
                  color: "#545b64",
                }}
              >
                새로운 기획
              </button>
            ) : undefined
          }
        >
          여행 상품 기획
        </Header>
      }
    >
      <SpaceBetween size="l">
        {/* Form mode progress bar */}
        {activeTab === "form" && (isFormRunning || formPlanning.error) && (
          <ProgressBar
            status={formPlanning.status}
            step={formPlanning.progress.step}
            percent={formPlanning.progress.percent}
            errorMessage={formPlanning.error || undefined}
          />
        )}

        <Grid
          gridDefinition={
            hasResult
              ? [{ colspan: 5 }, { colspan: 7 }]
              : [{ colspan: 12 }]
          }
        >
          <div>
            <Tabs
              activeTabId={activeTab}
              onChange={({ detail }) => setActiveTab(detail.activeTabId)}
              tabs={[
                {
                  label: "챗 모드",
                  id: "chat",
                  content: (
                    <ChatMode
                      messages={chat.messages}
                      isLoading={chat.isLoading}
                      streamingText={chat.streamingText}
                      toolStatus={chat.toolStatus}
                      planningStatus={chat.planningStatus}
                      planningProgress={chat.planningProgress}
                      onSend={chat.sendMessage}
                      onReset={chat.reset}
                    />
                  ),
                },
                {
                  label: "폼 모드",
                  id: "form",
                  content: (
                    <FormMode
                      onSubmit={handleFormSubmit}
                      disabled={isFormRunning}
                    />
                  ),
                },
              ]}
            />
          </div>
          {hasResult && activeResult && (
            <div>
              <ResultPanel result={activeResult} />
            </div>
          )}
        </Grid>
      </SpaceBetween>
    </ContentLayout>
  );
}
