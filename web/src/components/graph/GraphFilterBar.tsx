"use client";

import Multiselect from "@cloudscape-design/components/multiselect";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
interface GraphFilterBarProps {
  availableTypes: string[];
  selectedTypes: string[];
  onTypesChange: (types: string[]) => void;
  stats: Record<string, number>;
}

export default function GraphFilterBar({
  availableTypes,
  selectedTypes,
  onTypesChange,
  stats,
}: GraphFilterBarProps) {
  const options = availableTypes.map((type) => ({
    label: `${type} (${stats[type] || 0})`,
    value: type,
    iconName: undefined,
    tags: undefined,
  }));

  const totalNodes = Object.values(stats).reduce((a, b) => a + b, 0);

  return (
    <SpaceBetween size="s" direction="horizontal" alignItems="center">
      <Multiselect
        selectedOptions={selectedTypes.map((t) => ({
          label: `${t} (${stats[t] || 0})`,
          value: t,
        }))}
        onChange={({ detail }) => {
          onTypesChange(
            detail.selectedOptions.map((o) => o.value!).filter(Boolean)
          );
        }}
        options={options}
        placeholder="노드 타입 필터"
        filteringType="auto"
        expandToViewport
      />
      <Box variant="small" color="text-body-secondary">
        노드 {totalNodes}개
      </Box>
    </SpaceBetween>
  );
}
