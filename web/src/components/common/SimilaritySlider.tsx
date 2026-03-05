"use client";

import FormField from "@cloudscape-design/components/form-field";
import Slider from "@cloudscape-design/components/slider";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import Badge from "@cloudscape-design/components/badge";

const LAYER_RANGES = [
  { min: 90, max: 100, label: "L5만 변경", description: "기존 상품 리브랜딩", color: "green" as const },
  { min: 70, max: 89, label: "L4~L5 변경", description: "시즌 한정 변형 상품", color: "blue" as const },
  { min: 50, max: 69, label: "L3~L5 변경", description: "테마 변경 (가족→커플)", color: "blue" as const },
  { min: 30, max: 49, label: "L2~L5 변경", description: "같은 지역 신규 상품", color: "grey" as const },
  { min: 0, max: 29, label: "L1~L5 전체 변경", description: "완전 신규 상품 기획", color: "red" as const },
];

interface SimilaritySliderProps {
  value: number;
  onChange: (value: number) => void;
}

export default function SimilaritySlider({
  value,
  onChange,
}: SimilaritySliderProps) {
  const currentRange = LAYER_RANGES.find(
    (r) => value >= r.min && value <= r.max
  ) || LAYER_RANGES[2];

  return (
    <FormField
      label="유사도 (Similarity Level)"
      description="기존 상품 대비 새 상품의 유사 정도를 설정합니다. 낮을수록 더 많은 요소가 변경됩니다."
    >
      <SpaceBetween size="s">
        <Slider
          value={value}
          onChange={({ detail }) => onChange(detail.value)}
          min={0}
          max={100}
          step={5}
          valueFormatter={(v) => `${v}%`}
        />

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            color: "#687078",
            padding: "0 4px",
          }}
        >
          <span>0% (완전 신규)</span>
          <span>50% (테마 변경)</span>
          <span>100% (리브랜딩)</span>
        </div>

        <Box variant="div">
          <Badge color={currentRange.color}>{currentRange.label}</Badge>
          <Box
            variant="span"
            color="text-body-secondary"
            padding={{ left: "xs" }}
            fontSize="body-s"
          >
            {currentRange.description}
          </Box>
        </Box>

        {/* 5-Layer visualization */}
        <div
          style={{
            display: "flex",
            gap: 4,
            marginTop: 4,
          }}
        >
          {[
            { label: "L1 노선", weight: 0.95 },
            { label: "L2 숙박", weight: 0.70 },
            { label: "L3 관광지", weight: 0.50 },
            { label: "L4 액티비티", weight: 0.30 },
            { label: "L5 테마", weight: 0.10 },
          ].map((layer) => {
            const threshold = 1.0 - value / 100;
            const retained = layer.weight > threshold;
            return (
              <div
                key={layer.label}
                style={{
                  flex: 1,
                  padding: "6px 4px",
                  borderRadius: 4,
                  textAlign: "center",
                  fontSize: 11,
                  backgroundColor: retained ? "#d1e7dd" : "#f8d7da",
                  color: retained ? "#0f5132" : "#842029",
                  border: `1px solid ${retained ? "#badbcc" : "#f5c2c7"}`,
                }}
              >
                {layer.label}
                <br />
                <strong>{retained ? "유지" : "변경"}</strong>
              </div>
            );
          })}
        </div>
      </SpaceBetween>
    </FormField>
  );
}
