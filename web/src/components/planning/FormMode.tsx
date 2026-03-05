"use client";

import { useState } from "react";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Select from "@cloudscape-design/components/select";
import Input from "@cloudscape-design/components/input";
import Textarea from "@cloudscape-design/components/textarea";
import Multiselect from "@cloudscape-design/components/multiselect";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import type { PlanningInput } from "@/lib/types";
import {
  REGIONS,
  SUB_REGIONS,
  SEASONS,
  THEMES,
  SHOPPING_OPTIONS,
  MEAL_OPTIONS,
  HOTEL_GRADES,
} from "@/lib/types";
import SimilaritySlider from "../common/SimilaritySlider";

interface FormModeProps {
  onSubmit: (input: PlanningInput) => void;
  disabled?: boolean;
}

export default function FormMode({ onSubmit, disabled }: FormModeProps) {
  const [region, setRegion] = useState<string>("");
  const [destination, setDestination] = useState<string>("");
  const [nights, setNights] = useState("3");
  const [days, setDays] = useState("4");
  const [season, setSeason] = useState<string>("");
  const [referenceProductId, setReferenceProductId] = useState("");
  const [similarityLevel, setSimilarityLevel] = useState(50);
  const [selectedThemes, setSelectedThemes] = useState<string[]>([]);
  const [targetCustomer, setTargetCustomer] = useState("");
  const [maxBudget, setMaxBudget] = useState("");
  const [maxShopping, setMaxShopping] = useState("-1");
  const [mealPreference, setMealPreference] = useState("");
  const [hotelGrade, setHotelGrade] = useState("");
  const [naturalLanguageRequest, setNaturalLanguageRequest] = useState("");

  const handleSubmit = () => {
    const input: PlanningInput = {
      destination: destination || region,
      duration: {
        nights: parseInt(nights, 10) || 3,
        days: parseInt(days, 10) || 4,
      },
      departure_season: season,
      similarity_level: similarityLevel,
      themes: selectedThemes,
      input_mode: "form",
    };

    if (referenceProductId) {
      input.reference_product_id = referenceProductId;
    }
    if (targetCustomer) {
      input.target_customer = targetCustomer;
    }
    if (maxBudget) {
      input.max_budget_per_person = parseInt(maxBudget.replace(/,/g, ""), 10);
    }
    if (maxShopping !== "-1") {
      input.max_shopping_count = parseInt(maxShopping, 10);
    }
    if (mealPreference) {
      input.meal_preference = mealPreference;
    }
    if (hotelGrade) {
      input.hotel_grade = hotelGrade;
    }
    if (naturalLanguageRequest) {
      input.natural_language_request = naturalLanguageRequest;
    }

    onSubmit(input);
  };

  const isValid = (destination || region) && season && nights && days;

  return (
    <Form
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={disabled || !isValid}
            loading={disabled}
          >
            일정 생성 시작
          </Button>
        </SpaceBetween>
      }
    >
      <SpaceBetween size="l">
        {/* Required fields */}
        <Container header={<Header variant="h2">필수 정보</Header>}>
          <SpaceBetween size="m">
            <ColumnLayout columns={4}>
              <FormField label="지역">
                <Select
                  selectedOption={
                    region
                      ? { value: region, label: REGIONS.find((r) => r.value === region)?.label || region }
                      : null
                  }
                  onChange={({ detail }) => {
                    setRegion(detail.selectedOption.value || "");
                    setDestination(""); // reset sub-region
                  }}
                  options={REGIONS.map((r) => ({ value: r.value, label: r.label }))}
                  placeholder="지역 선택"
                />
              </FormField>

              <FormField label="세부 지역 (선택)">
                <Select
                  selectedOption={
                    destination
                      ? {
                          value: destination,
                          label: SUB_REGIONS[region]?.find((s) => s.value === destination)?.label || destination,
                        }
                      : null
                  }
                  onChange={({ detail }) =>
                    setDestination(detail.selectedOption.value || "")
                  }
                  options={(SUB_REGIONS[region] || []).map((s) => ({ value: s.value, label: s.label }))}
                  placeholder={region ? "세부 지역 선택" : "지역을 먼저 선택하세요"}
                  disabled={!region}
                />
              </FormField>

              <FormField label="여행 기간">
                <SpaceBetween direction="horizontal" size="xs">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Input
                      type="number"
                      value={nights}
                      onChange={({ detail }) => {
                        setNights(detail.value);
                        const n = parseInt(detail.value, 10);
                        if (!isNaN(n)) setDays(String(n + 1));
                      }}
                      inputMode="numeric"
                    />
                    <span>박</span>
                    <Input
                      type="number"
                      value={days}
                      onChange={({ detail }) => setDays(detail.value)}
                      inputMode="numeric"
                    />
                    <span>일</span>
                  </div>
                </SpaceBetween>
              </FormField>

              <FormField label="출발 시기">
                <Select
                  selectedOption={
                    season
                      ? {
                          value: season,
                          label:
                            SEASONS.find((s) => s.value === season)
                              ?.label || season,
                        }
                      : null
                  }
                  onChange={({ detail }) =>
                    setSeason(detail.selectedOption.value || "")
                  }
                  options={SEASONS.map((s) => ({
                    value: s.value,
                    label: s.label,
                  }))}
                  placeholder="시즌 선택"
                />
              </FormField>
            </ColumnLayout>
          </SpaceBetween>
        </Container>

        {/* Reference product & similarity */}
        <Container header={<Header variant="h2">참고 상품</Header>}>
          <SpaceBetween size="m">
            <FormField
              label="기존 상품 코드"
              description="기존 패키지 상품 코드를 입력하면 해당 상품을 기반으로 기획합니다."
            >
              <Input
                value={referenceProductId}
                onChange={({ detail }) =>
                  setReferenceProductId(detail.value)
                }
                placeholder="예: JKP130260401TWX"
              />
            </FormField>

            <SimilaritySlider
              value={similarityLevel}
              onChange={setSimilarityLevel}
            />
          </SpaceBetween>
        </Container>

        {/* Theme selection */}
        <Container header={<Header variant="h2">테마</Header>}>
          <FormField
            label="테마 선택"
            description="하나 이상의 테마를 선택하세요."
          >
            <Multiselect
              selectedOptions={selectedThemes.map((t) => ({
                value: t,
                label: THEMES.find((th) => th.value === t)?.label || t,
              }))}
              onChange={({ detail }) =>
                setSelectedThemes(
                  detail.selectedOptions
                    .map((o) => o.value)
                    .filter((v): v is string => v !== undefined)
                )
              }
              options={THEMES.map((t) => ({
                value: t.value,
                label: t.label,
              }))}
              placeholder="테마를 선택하세요"
              tokenLimit={5}
            />
          </FormField>
        </Container>

        {/* Package characteristics */}
        <Container header={<Header variant="h2">패키지 특성</Header>}>
          <ColumnLayout columns={3}>
            <FormField label="쇼핑 횟수">
              <Select
                selectedOption={
                  maxShopping !== undefined
                    ? {
                        value: maxShopping,
                        label:
                          SHOPPING_OPTIONS.find(
                            (s) => s.value === maxShopping
                          )?.label || maxShopping,
                      }
                    : null
                }
                onChange={({ detail }) =>
                  setMaxShopping(detail.selectedOption.value || "-1")
                }
                options={SHOPPING_OPTIONS.map((s) => ({
                  value: s.value,
                  label: s.label,
                }))}
              />
            </FormField>

            <FormField label="식사 포함">
              <Select
                selectedOption={
                  mealPreference
                    ? {
                        value: mealPreference,
                        label:
                          MEAL_OPTIONS.find(
                            (m) => m.value === mealPreference
                          )?.label || mealPreference,
                      }
                    : null
                }
                onChange={({ detail }) =>
                  setMealPreference(detail.selectedOption.value || "")
                }
                options={MEAL_OPTIONS.map((m) => ({
                  value: m.value,
                  label: m.label,
                }))}
                placeholder="식사 옵션 선택"
              />
            </FormField>

            <FormField label="호텔 등급">
              <Select
                selectedOption={
                  hotelGrade
                    ? {
                        value: hotelGrade,
                        label:
                          HOTEL_GRADES.find(
                            (h) => h.value === hotelGrade
                          )?.label || hotelGrade,
                      }
                    : null
                }
                onChange={({ detail }) =>
                  setHotelGrade(detail.selectedOption.value || "")
                }
                options={HOTEL_GRADES.map((h) => ({
                  value: h.value,
                  label: h.label,
                }))}
                placeholder="호텔 등급 선택"
              />
            </FormField>
          </ColumnLayout>
        </Container>

        {/* Additional requests */}
        <Container header={<Header variant="h2">추가 요구사항</Header>}>
          <SpaceBetween size="m">
            <ColumnLayout columns={2}>
              <FormField label="타겟 고객">
                <Input
                  value={targetCustomer}
                  onChange={({ detail }) =>
                    setTargetCustomer(detail.value)
                  }
                  placeholder="예: 30대 커플, 가족 (아이 2명)"
                />
              </FormField>

              <FormField label="1인당 최대 예산 (원)">
                <Input
                  value={maxBudget}
                  onChange={({ detail }) => setMaxBudget(detail.value)}
                  placeholder="예: 1500000"
                  inputMode="numeric"
                />
              </FormField>
            </ColumnLayout>

            <FormField
              label="자유 텍스트 요청"
              description="추가로 원하는 조건이나 요구사항을 자유롭게 입력하세요."
            >
              <Textarea
                value={naturalLanguageRequest}
                onChange={({ detail }) =>
                  setNaturalLanguageRequest(detail.value)
                }
                placeholder="예: 인스타 핫플 위주로 구성, 미쉐린 레스토랑 포함"
                rows={3}
              />
            </FormField>
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    </Form>
  );
}
