"use client";

import FormField from "@cloudscape-design/components/form-field";
import Slider from "@cloudscape-design/components/slider";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import Badge from "@cloudscape-design/components/badge";

const MIX_RANGES = [
  { min: 81, max: 100, label: "핫 위주", description: "바이럴 트렌드 중심 구성", color: "red" as const },
  { min: 61, max: 80, label: "핫 중심", description: "핫 트렌드 우선 + 스테디 보조", color: "red" as const },
  { min: 41, max: 60, label: "균형", description: "핫/스테디 균형 배합", color: "blue" as const },
  { min: 21, max: 40, label: "스테디 중심", description: "검증된 트렌드 우선 + 핫 보조", color: "blue" as const },
  { min: 0, max: 20, label: "스테디 위주", description: "안정적 인기 트렌드 중심 구성", color: "green" as const },
];

interface TrendMixSliderProps {
  value: number;
  onChange: (value: number) => void;
}

export default function TrendMixSlider({
  value,
  onChange,
}: TrendMixSliderProps) {
  const steady = 100 - value;
  const currentRange = MIX_RANGES.find(
    (r) => value >= r.min && value <= r.max
  ) || MIX_RANGES[2];

  return (
    <FormField
      label="트렌드 배합 (Trend Mix)"
      description="핫 트렌드(바이럴)와 스테디 트렌드(검증된 인기)의 배합 비율을 설정합니다."
    >
      <SpaceBetween size="s">
        <Slider
          value={value}
          onChange={({ detail }) => onChange(detail.value)}
          min={0}
          max={100}
          step={10}
          valueFormatter={(v) => `핫 ${v}% : 스테디 ${100 - v}%`}
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
          <span>스테디 100%</span>
          <span>균형 50:50</span>
          <span>핫 100%</span>
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

        {/* Hot:Steady ratio visualization bar */}
        <div
          style={{
            display: "flex",
            height: 24,
            borderRadius: 4,
            overflow: "hidden",
            border: "1px solid #e9ebed",
          }}
        >
          <div
            style={{
              width: `${value}%`,
              backgroundColor: "#d13212",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              color: value > 15 ? "#fff" : "transparent",
              transition: "width 0.2s",
            }}
          >
            핫 {value}%
          </div>
          <div
            style={{
              width: `${steady}%`,
              backgroundColor: "#0972d3",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              color: steady > 15 ? "#fff" : "transparent",
              transition: "width 0.2s",
            }}
          >
            스테디 {steady}%
          </div>
        </div>
      </SpaceBetween>
    </FormField>
  );
}
