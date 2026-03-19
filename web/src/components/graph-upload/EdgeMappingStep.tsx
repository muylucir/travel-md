"use client";

import { useCallback, useMemo } from "react";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import FormField from "@cloudscape-design/components/form-field";
import Select from "@cloudscape-design/components/select";
import Input from "@cloudscape-design/components/input";
import Toggle from "@cloudscape-design/components/toggle";
import Button from "@cloudscape-design/components/button";
import Box from "@cloudscape-design/components/box";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Alert from "@cloudscape-design/components/alert";
import Autosuggest from "@cloudscape-design/components/autosuggest";
import {
  EXISTING_NODE_LABELS,
  COMMON_EDGE_LABELS,
  FIELD_TO_NODE_HINTS,
  type EdgeMappingRule,
} from "./types";

interface EdgeMappingStepProps {
  jsonFields: string[];
  edgeMappings: EdgeMappingRule[];
  onChange: (rules: EdgeMappingRule[]) => void;
  nodeLabel: string;
}

function generateId() {
  return Math.random().toString(36).slice(2, 9);
}

export default function EdgeMappingStep({
  jsonFields,
  edgeMappings,
  onChange,
  nodeLabel,
}: EdgeMappingStepProps) {
  const fieldOptions = jsonFields.map((f) => ({ value: f, label: f }));

  const targetLabelOptions = EXISTING_NODE_LABELS.filter(
    (l) => l !== nodeLabel
  ).map((l) => ({ value: l, label: l }));

  const edgeLabelSuggestions = COMMON_EDGE_LABELS.map((l) => ({ value: l }));

  const mappedFields = useMemo(
    () => new Set(edgeMappings.map((r) => r.sourceField)),
    [edgeMappings]
  );

  const suggestableFields = useMemo(() => {
    return jsonFields.filter((f) => {
      const hint = FIELD_TO_NODE_HINTS[f.toLowerCase()];
      return hint && !mappedFields.has(f);
    });
  }, [jsonFields, mappedFields]);

  const handleAutoSuggest = useCallback(() => {
    const newRules: EdgeMappingRule[] = [];
    for (const field of suggestableFields) {
      const hint = FIELD_TO_NODE_HINTS[field.toLowerCase()];
      if (hint) {
        newRules.push({
          id: generateId(),
          sourceField: field,
          targetNodeLabel: hint.nodeLabel,
          targetMatchProperty: hint.matchProp,
          edgeLabel: hint.edgeLabel,
          direction: "out",
          autoCreateTarget: true,
        });
      }
    }
    onChange([...edgeMappings, ...newRules]);
  }, [suggestableFields, edgeMappings, onChange]);

  const addRule = useCallback(() => {
    onChange([
      ...edgeMappings,
      {
        id: generateId(),
        sourceField: "",
        targetNodeLabel: "",
        targetMatchProperty: "name",
        edgeLabel: "",
        direction: "out",
        autoCreateTarget: true,
      },
    ]);
  }, [edgeMappings, onChange]);

  const removeRule = useCallback(
    (id: string) => {
      onChange(edgeMappings.filter((r) => r.id !== id));
    },
    [edgeMappings, onChange]
  );

  const updateRule = useCallback(
    (id: string, update: Partial<EdgeMappingRule>) => {
      onChange(
        edgeMappings.map((r) => (r.id === id ? { ...r, ...update } : r))
      );
    },
    [edgeMappings, onChange]
  );

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description="JSON 필드 값을 기존 노드와 연결하는 엣지(관계) 규칙을 설정합니다."
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                {suggestableFields.length > 0 && (
                  <Button onClick={handleAutoSuggest} iconName="gen-ai">
                    자동 추천 ({suggestableFields.length})
                  </Button>
                )}
                <Button onClick={addRule} iconName="add-plus">
                  규칙 추가
                </Button>
              </SpaceBetween>
            }
          >
            엣지 매핑 규칙
          </Header>
        }
      >
        <SpaceBetween size="l">
          {suggestableFields.length > 0 && edgeMappings.length === 0 && (
            <Alert type="info">
              자동 추천 가능한 필드가 {suggestableFields.length}개 있습니다:{" "}
              <strong>{suggestableFields.join(", ")}</strong>. &quot;자동
              추천&quot; 버튼을 클릭하세요.
            </Alert>
          )}

          {edgeMappings.length === 0 && suggestableFields.length === 0 && (
            <Box textAlign="center" color="text-body-secondary" padding="l">
              설정된 엣지 규칙이 없습니다. &quot;규칙 추가&quot; 버튼을
              클릭하여 관계를 설정하세요.
            </Box>
          )}

          {edgeMappings.map((rule, idx) => (
            <Container
              key={rule.id}
              header={
                <Header
                  variant="h3"
                  actions={
                    <Button
                      variant="icon"
                      iconName="remove"
                      onClick={() => removeRule(rule.id)}
                    />
                  }
                >
                  규칙 #{idx + 1}
                  {rule.sourceField &&
                    rule.targetNodeLabel &&
                    rule.edgeLabel && (
                      <Box
                        variant="small"
                        color="text-body-secondary"
                        display="inline"
                        margin={{ left: "s" }}
                      >
                        {nodeLabel} —[{rule.edgeLabel}]
                        {rule.direction === "out" ? "→" : "←"}{" "}
                        {rule.targetNodeLabel}
                      </Box>
                    )}
                </Header>
              }
            >
              <ColumnLayout columns={3}>
                <FormField label="소스 필드">
                  <Select
                    selectedOption={
                      fieldOptions.find(
                        (o) => o.value === rule.sourceField
                      ) || null
                    }
                    onChange={({ detail }) =>
                      updateRule(rule.id, {
                        sourceField: detail.selectedOption.value!,
                      })
                    }
                    options={fieldOptions}
                    placeholder="필드 선택"
                  />
                </FormField>

                <FormField label="대상 노드 타입">
                  <Select
                    selectedOption={
                      targetLabelOptions.find(
                        (o) => o.value === rule.targetNodeLabel
                      ) || null
                    }
                    onChange={({ detail }) =>
                      updateRule(rule.id, {
                        targetNodeLabel: detail.selectedOption.value!,
                      })
                    }
                    options={targetLabelOptions}
                    placeholder="노드 타입 선택"
                  />
                </FormField>

                <FormField
                  label="매칭 속성"
                  description="대상 노드에서 값을 매칭할 속성"
                >
                  <Input
                    value={rule.targetMatchProperty}
                    onChange={({ detail }) =>
                      updateRule(rule.id, {
                        targetMatchProperty: detail.value,
                      })
                    }
                    placeholder="name"
                  />
                </FormField>

                <FormField label="엣지 라벨">
                  <Autosuggest
                    value={rule.edgeLabel}
                    onChange={({ detail }) =>
                      updateRule(rule.id, { edgeLabel: detail.value })
                    }
                    options={edgeLabelSuggestions}
                    placeholder="LOCATED_IN"
                    enteredTextLabel={(v) => `사용: "${v}"`}
                  />
                </FormField>

                <FormField label="방향">
                  <Select
                    selectedOption={{
                      value: rule.direction,
                      label:
                        rule.direction === "out"
                          ? `→ (${nodeLabel || "현재"} → ${rule.targetNodeLabel || "대상"})`
                          : `← (${rule.targetNodeLabel || "대상"} → ${nodeLabel || "현재"})`,
                    }}
                    onChange={({ detail }) =>
                      updateRule(rule.id, {
                        direction: detail.selectedOption.value as "out" | "in",
                      })
                    }
                    options={[
                      {
                        value: "out",
                        label: `→ (${nodeLabel || "현재"} → ${rule.targetNodeLabel || "대상"})`,
                      },
                      {
                        value: "in",
                        label: `← (${rule.targetNodeLabel || "대상"} → ${nodeLabel || "현재"})`,
                      },
                    ]}
                  />
                </FormField>

                <FormField label="자동 생성">
                  <Toggle
                    checked={rule.autoCreateTarget}
                    onChange={({ detail }) =>
                      updateRule(rule.id, {
                        autoCreateTarget: detail.checked,
                      })
                    }
                  >
                    대상 노드 없으면 자동 생성
                  </Toggle>
                </FormField>
              </ColumnLayout>
            </Container>
          ))}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
