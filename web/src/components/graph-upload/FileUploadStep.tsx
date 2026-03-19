"use client";

import { useCallback, useState } from "react";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import Table from "@cloudscape-design/components/table";
import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";

interface FileUploadStepProps {
  rawData: Record<string, unknown>[] | null;
  fileName: string;
  onFileLoad: (data: Record<string, unknown>[], fileName: string) => void;
}

export default function FileUploadStep({
  rawData,
  fileName,
  onFileLoad,
}: FileUploadStepProps) {
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const parseFile = useCallback(
    (file: File) => {
      setError(null);
      if (!file.name.endsWith(".json")) {
        setError("JSON 파일만 업로드 가능합니다.");
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const text = e.target?.result as string;
          const parsed = JSON.parse(text);
          if (!Array.isArray(parsed)) {
            setError(
              'JSON 파일은 배열 형태여야 합니다. 예: [{"name": "..."}, ...]'
            );
            return;
          }
          if (parsed.length === 0) {
            setError("빈 배열입니다. 데이터가 있는 JSON 파일을 업로드하세요.");
            return;
          }
          onFileLoad(parsed, file.name);
        } catch {
          setError("JSON 파싱 오류: 유효한 JSON 파일인지 확인하세요.");
        }
      };
      reader.readAsText(file);
    },
    [onFileLoad]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) parseFile(file);
    },
    [parseFile]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) parseFile(file);
    },
    [parseFile]
  );

  const fields = rawData ? Object.keys(rawData[0] || {}) : [];
  const preview = rawData?.slice(0, 5) || [];

  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2">JSON 파일 업로드</Header>}>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() =>
            document.getElementById("graph-upload-file-input")?.click()
          }
          style={{
            border: `2px dashed ${dragOver ? "#0972d3" : "#d5dbdb"}`,
            borderRadius: 8,
            padding: 48,
            textAlign: "center",
            background: dragOver ? "#f2f8fd" : "#fafafa",
            cursor: "pointer",
            transition: "all 0.2s",
          }}
        >
          <input
            id="graph-upload-file-input"
            type="file"
            accept=".json"
            onChange={handleFileInput}
            style={{ display: "none" }}
          />
          <Box variant="h3" color="text-body-secondary">
            JSON 파일을 여기에 드래그하거나 클릭하여 선택
          </Box>
          <Box
            variant="small"
            color="text-body-secondary"
            margin={{ top: "xs" }}
          >
            플랫 JSON 배열 형식 지원
          </Box>
          <div style={{ marginTop: 12 }}>
            <Button iconName="upload">파일 선택</Button>
          </div>
        </div>
      </Container>

      {error && <Alert type="error">{error}</Alert>}

      {rawData && (
        <>
          <Container header={<Header variant="h2">파일 정보</Header>}>
            <ColumnLayout columns={3}>
              <div>
                <Box variant="awsui-key-label">파일명</Box>
                <div>{fileName}</div>
              </div>
              <div>
                <Box variant="awsui-key-label">레코드 수</Box>
                <div>{rawData.length.toLocaleString()}건</div>
              </div>
              <div>
                <Box variant="awsui-key-label">감지된 필드</Box>
                <div>{fields.join(", ")}</div>
              </div>
            </ColumnLayout>
          </Container>

          <Container
            header={
              <Header
                variant="h2"
                counter={`(${Math.min(5, rawData.length)}/${rawData.length})`}
              >
                데이터 미리보기
              </Header>
            }
          >
            <Table
              items={preview}
              columnDefinitions={fields.map((f) => ({
                id: f,
                header: f,
                cell: (item: Record<string, unknown>) => {
                  const v = item[f];
                  if (v === null || v === undefined) return "-";
                  if (typeof v === "object") return JSON.stringify(v);
                  return String(v);
                },
                width: Math.max(100, Math.min(250, f.length * 12 + 40)),
              }))}
              variant="embedded"
              stripedRows
              wrapLines
            />
          </Container>
        </>
      )}
    </SpaceBetween>
  );
}
