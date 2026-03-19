"use client";

import { useState } from "react";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import FormField from "@cloudscape-design/components/form-field";
import Select from "@cloudscape-design/components/select";
import Input from "@cloudscape-design/components/input";
import Table from "@cloudscape-design/components/table";
import Toggle from "@cloudscape-design/components/toggle";
import Box from "@cloudscape-design/components/box";
import Badge from "@cloudscape-design/components/badge";
import {
  EXISTING_NODE_LABELS,
  type NodeDesignConfig,
  type PropertyMapping,
} from "./types";

interface NodeDesignStepProps {
  jsonFields: string[];
  sampleData: Record<string, unknown>[];
  nodeDesign: NodeDesignConfig;
  onChange: (config: NodeDesignConfig) => void;
}

const CUSTOM_LABEL_VALUE = "__custom__";

export default function NodeDesignStep({
  jsonFields,
  sampleData,
  nodeDesign,
  onChange,
}: NodeDesignStepProps) {
  const [useCustomLabel, setUseCustomLabel] = useState(
    nodeDesign.nodeLabel !== "" &&
      !EXISTING_NODE_LABELS.includes(nodeDesign.nodeLabel)
  );

  const labelOptions = [
    ...EXISTING_NODE_LABELS.map((l) => ({ value: l, label: l })),
    { value: CUSTOM_LABEL_VALUE, label: "새 타입 직접 입력..." },
  ];

  const fieldOptions = jsonFields.map((f) => ({ value: f, label: f }));

  const handleLabelSelect = (value: string) => {
    if (value === CUSTOM_LABEL_VALUE) {
      setUseCustomLabel(true);
      onChange({ ...nodeDesign, nodeLabel: "" });
    } else {
      setUseCustomLabel(false);
      onChange({ ...nodeDesign, nodeLabel: value });
    }
  };

  const handleMappingChange = (
    jsonField: string,
    update: Partial<PropertyMapping>
  ) => {
    const newMappings = nodeDesign.propertyMappings.map((m) =>
      m.jsonField === jsonField ? { ...m, ...update } : m
    );
    onChange({ ...nodeDesign, propertyMappings: newMappings });
  };

  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2">노드 타입 설정</Header>}>
        <SpaceBetween size="m">
          <FormField
            label="노드 라벨"
            description="생성할 노드의 타입을 선택하세요"
          >
            <Select
              selectedOption={
                useCustomLabel
                  ? {
                      value: CUSTOM_LABEL_VALUE,
                      label: "새 타입 직접 입력...",
                    }
                  : labelOptions.find(
                      (o) => o.value === nodeDesign.nodeLabel
                    ) || null
              }
              onChange={({ detail }) =>
                handleLabelSelect(detail.selectedOption.value!)
              }
              options={labelOptions}
              placeholder="노드 타입 선택"
            />
          </FormField>

          {useCustomLabel && (
            <FormField
              label="커스텀 노드 라벨"
              description="PascalCase로 입력하세요 (예: Restaurant, Museum)"
            >
              <Input
                value={nodeDesign.nodeLabel}
                onChange={({ detail }) =>
                  onChange({ ...nodeDesign, nodeLabel: detail.value })
                }
                placeholder="노드 타입명"
              />
            </FormField>
          )}

          <FormField
            label="ID 필드"
            description="노드를 고유하게 식별할 필드를 선택하세요. 이 값이 Neptune vertex ID로 사용됩니다."
          >
            <Select
              selectedOption={
                fieldOptions.find((o) => o.value === nodeDesign.idField) || null
              }
              onChange={({ detail }) =>
                onChange({ ...nodeDesign, idField: detail.selectedOption.value! })
              }
              options={fieldOptions}
              placeholder="ID 필드 선택"
            />
          </FormField>
        </SpaceBetween>
      </Container>

      <Container
        header={
          <Header
            variant="h2"
            description="JSON 필드를 노드 속성으로 매핑합니다. 불필요한 필드는 제외할 수 있습니다."
          >
            속성 매핑
          </Header>
        }
      >
        <Table
          items={nodeDesign.propertyMappings}
          columnDefinitions={[
            {
              id: "include",
              header: "포함",
              cell: (item) => (
                <Toggle
                  checked={item.include}
                  onChange={({ detail }) =>
                    handleMappingChange(item.jsonField, {
                      include: detail.checked,
                    })
                  }
                />
              ),
              width: 80,
            },
            {
              id: "jsonField",
              header: "JSON 필드",
              cell: (item) => (
                <Box fontWeight="bold">
                  {item.jsonField}
                  {item.jsonField === nodeDesign.idField && (
                    <Badge color="blue"> ID</Badge>
                  )}
                </Box>
              ),
              width: 160,
            },
            {
              id: "nodeProperty",
              header: "노드 속성명",
              cell: (item) => (
                <Input
                  value={item.nodeProperty}
                  onChange={({ detail }) =>
                    handleMappingChange(item.jsonField, {
                      nodeProperty: detail.value,
                    })
                  }
                  disabled={!item.include}
                />
              ),
              width: 200,
            },
            {
              id: "sample",
              header: "샘플 데이터 (상위 3건)",
              cell: (item) => {
                const values = sampleData.slice(0, 3).map((d) => {
                  const v = d[item.jsonField];
                  if (v === null || v === undefined) return "null";
                  return typeof v === "object" ? JSON.stringify(v) : String(v);
                });
                return (
                  <Box color="text-body-secondary">
                    {values.join(" / ")}
                  </Box>
                );
              },
            },
          ]}
          variant="embedded"
          stripedRows
        />
      </Container>
    </SpaceBetween>
  );
}
