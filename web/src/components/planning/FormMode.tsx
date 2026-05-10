"use client";

import { useState, useEffect } from "react";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Select from "@cloudscape-design/components/select";
import Input from "@cloudscape-design/components/input";
import Textarea from "@cloudscape-design/components/textarea";
import Multiselect from "@cloudscape-design/components/multiselect";
import RadioGroup from "@cloudscape-design/components/radio-group";
import Button from "@cloudscape-design/components/button";
import Alert from "@cloudscape-design/components/alert";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import type { PlanningInput } from "@/lib/types";
import {
  REGIONS,
  SUB_REGIONS,
  SEASONS,
  THEMES_COMPANION,
  THEMES_INTEREST,
  BRANDS,
  MEAL_OPTIONS,
  HOTEL_GRADES,
} from "@/lib/types";
import SimilaritySlider from "../common/SimilaritySlider";
import { usePackages } from "@/hooks/usePackages";
import RecommendedPackageCards from "./RecommendedPackageCards";
import ProgressBar from "./ProgressBar";
import type { PlanningStatus } from "@/hooks/usePlanning";

// 시즌 → BEST_IN_SEASON.quarter 매핑
const SEASON_QUARTER_MAP: Record<string, number> = {
  봄: 2,
  여름: 3,
  가을: 4,
  겨울: 1,
};

interface FormModeProps {
  onSubmit: (input: PlanningInput) => void;
  disabled?: boolean;
  /** Progress bar shown right above the submit button while planning runs. */
  progress?: {
    status: PlanningStatus;
    step: string;
    percent: number;
    errorMessage?: string;
  } | null;
}

export default function FormMode({ onSubmit, disabled, progress }: FormModeProps) {
  const [region] = useState<string>("일본"); // 간사이 4도시 고정
  const [destination, setDestination] = useState<string>("");
  const [nights, setNights] = useState("3");
  const [days, setDays] = useState("4");
  const [season, setSeason] = useState<string>("");
  const [referenceProductId, setReferenceProductId] = useState("");
  const [similarityLevel, setSimilarityLevel] = useState(50);
  const [companion, setCompanion] = useState<string>("");
  const [interests, setInterests] = useState<string[]>([]);
  const [brand, setBrand] = useState<string>("스탠다드");
  const [targetCustomer, setTargetCustomer] = useState("");
  const [mealPreference, setMealPreference] = useState("");
  const [hotelGrade, setHotelGrade] = useState("");
  const [naturalLanguageRequest, setNaturalLanguageRequest] = useState("");

  // 추천 패키지 (도시·박수·시즌·테마·브랜드 변경 시 자동 갱신)
  const {
    packages: recommendedPackages,
    loading: recLoading,
    error: recError,
    refresh: refreshRecommended,
  } = usePackages();

  // 참고 상품의 실제 도시·박수 (similarity 강제 충돌 검출용)
  const [referenceCities, setReferenceCities] = useState<string[]>([]);
  const [referenceNights, setReferenceNights] = useState<number | null>(null);

  useEffect(() => {
    if (!referenceProductId) {
      setReferenceCities([]);
      setReferenceNights(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/packages/${encodeURIComponent(referenceProductId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const cities = new Set<string>();
        if (data.arrivalCity?.name) cities.add(data.arrivalCity.name);
        for (const c of data.visitCities || []) {
          if (c?.name) cities.add(c.name);
        }
        setReferenceCities(Array.from(cities));
        const n = Number(data.saleProduct?.trvlNgtCnt);
        setReferenceNights(!isNaN(n) ? n : null);
      })
      .catch(() => {
        if (!cancelled) {
          setReferenceCities([]);
          setReferenceNights(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [referenceProductId]);

  // 충돌 검출: similarity ≥ 70 (L1 retain) + destination/nights 가 reference 와 다름
  const conflictWarnings = (() => {
    const out: string[] = [];
    if (!referenceProductId || similarityLevel < 70) return out;
    if (
      destination &&
      referenceCities.length > 0 &&
      !referenceCities.includes(destination)
    ) {
      out.push(
        `유사도 ${similarityLevel}%는 노선(L1)을 유지해야 하는데, 선택한 도시 "${destination}"가 기준 상품의 도시(${referenceCities.join(", ")})에 없습니다. 기준 상품의 도시 중 하나를 선택하거나 유사도를 낮추세요.`
      );
    }
    const nightsNum = parseInt(nights, 10);
    if (
      !isNaN(nightsNum) &&
      referenceNights !== null &&
      nightsNum !== referenceNights
    ) {
      out.push(
        `유사도 ${similarityLevel}%는 일정(L1)을 유지해야 하는데, 박수(${nightsNum}박)가 기준 상품(${referenceNights}박)과 다릅니다.`
      );
    }
    return out;
  })();

  useEffect(() => {
    if (!destination) return;
    const nightsNum = parseInt(nights, 10);
    const seasonQuarter = season ? SEASON_QUARTER_MAP[season] : undefined;
    const themeKey = companion || interests[0] || undefined;
    refreshRecommended({
      destination,
      nights: !isNaN(nightsNum) ? nightsNum : undefined,
      season_quarter: seasonQuarter,
      theme_key: themeKey,
      brand: brand || undefined,
      limit: 5,
    });
  }, [destination, nights, season, companion, interests, brand, refreshRecommended]);

  const handleSubmit = () => {
    const themes = [companion, ...interests].filter(Boolean);
    const input: PlanningInput = {
      destination: destination || region,
      duration: {
        nights: parseInt(nights, 10) || 3,
        days: parseInt(days, 10) || 4,
      },
      departure_season: season,
      similarity_level: similarityLevel,
      themes,
      brand,
      input_mode: "form",
    };

    if (referenceProductId) input.reference_product_id = referenceProductId;
    if (targetCustomer) input.target_customer = targetCustomer;
    if (mealPreference) input.meal_preference = mealPreference;
    if (hotelGrade) input.hotel_grade = hotelGrade;
    if (naturalLanguageRequest)
      input.natural_language_request = naturalLanguageRequest;

    onSubmit(input);
  };

  const isValid =
    destination && season && nights && days && conflictWarnings.length === 0;

  const showProgress =
    !!progress && (progress.status === "running" || progress.status === "error");

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
        <Container
          header={
            <Header
              variant="h2"
              description="간사이 지역 (오사카·교토·고베·나라) 4개 도시 한정"
            >
              필수 정보
            </Header>
          }
        >
          <SpaceBetween size="m">
            <ColumnLayout columns={4}>
              <FormField label="지역">
                <Input value={REGIONS[0].label} disabled />
              </FormField>

              <FormField label="도시">
                <Select
                  selectedOption={
                    destination
                      ? {
                          value: destination,
                          label:
                            SUB_REGIONS[region]?.find(
                              (s) => s.value === destination
                            )?.label || destination,
                        }
                      : null
                  }
                  onChange={({ detail }) =>
                    setDestination(detail.selectedOption.value || "")
                  }
                  options={(SUB_REGIONS[region] || []).map((s) => ({
                    value: s.value,
                    label: s.label,
                  }))}
                  placeholder="도시 선택"
                />
              </FormField>

              <FormField label="여행 기간">
                <SpaceBetween direction="horizontal" size="xs">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
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
                            SEASONS.find((s) => s.value === season)?.label ||
                            season,
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
        <Container
          header={
            <Header
              variant="h2"
              description="조건(도시·박수·시즌·테마·브랜드)이 채워지면 추천 상품이 자동으로 표시됩니다. 카드를 클릭해 참고 상품을 선택할 수 있습니다."
            >
              참고 상품
            </Header>
          }
        >
          <SpaceBetween size="m">
            <FormField
              label="기존 상품 코드 (saleProdCd)"
              description="직접 입력하거나 아래 추천 카드에서 선택하세요."
            >
              <Input
                value={referenceProductId}
                onChange={({ detail }) =>
                  setReferenceProductId(detail.value)
                }
                placeholder="예: JKP130260401TWX"
              />
            </FormField>

            {destination && (
              <RecommendedPackageCards
                packages={recommendedPackages}
                loading={recLoading}
                error={recError}
                selectedCode={referenceProductId}
                onSelect={(code) => setReferenceProductId(code)}
              />
            )}

            <SimilaritySlider
              value={similarityLevel}
              onChange={setSimilarityLevel}
              referenceProductId={referenceProductId}
            />

            {conflictWarnings.length > 0 && (
              <Alert
                type="warning"
                header={`유사도 ${similarityLevel}%와 다른 입력이 충돌합니다`}
              >
                <ul style={{ marginTop: 4, marginBottom: 4 }}>
                  {conflictWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
                충돌이 해소되어야 일정 생성을 시작할 수 있습니다.
              </Alert>
            )}
          </SpaceBetween>
        </Container>

        {/* Brand selection (replaces shopping count) */}
        <Container
          header={
            <Header
              variant="h2"
              description="세이브: 쇼핑 포함 / 스탠다드: 쇼핑 미포함"
            >
              브랜드
            </Header>
          }
        >
          <FormField label="브랜드 선택">
            <RadioGroup
              value={brand}
              onChange={({ detail }) => setBrand(detail.value)}
              items={BRANDS.map((b) => ({
                value: b.value,
                label: b.label,
              }))}
            />
          </FormField>
        </Container>

        {/* Themes — companion (single) + interest (multi) */}
        <Container
          header={
            <Header
              variant="h2"
              description="동반자 유형 1개 + 관심사 여러 개를 선택할 수 있습니다."
            >
              테마
            </Header>
          }
        >
          <ColumnLayout columns={2}>
            <FormField label="동반자 유형">
              <Select
                selectedOption={
                  companion
                    ? {
                        value: companion,
                        label:
                          THEMES_COMPANION.find((t) => t.value === companion)
                            ?.label || companion,
                      }
                    : null
                }
                onChange={({ detail }) =>
                  setCompanion(detail.selectedOption.value || "")
                }
                options={THEMES_COMPANION.map((t) => ({
                  value: t.value,
                  label: t.label,
                }))}
                placeholder="동반자 유형 선택"
              />
            </FormField>

            <FormField label="관심사 (복수 선택)">
              <Multiselect
                selectedOptions={interests.map((v) => ({
                  value: v,
                  label:
                    THEMES_INTEREST.find((t) => t.value === v)?.label || v,
                }))}
                onChange={({ detail }) =>
                  setInterests(
                    detail.selectedOptions
                      .map((o) => o.value)
                      .filter((v): v is string => v !== undefined)
                  )
                }
                options={THEMES_INTEREST.map((t) => ({
                  value: t.value,
                  label: t.label,
                }))}
                placeholder="관심사를 선택하세요"
                tokenLimit={5}
              />
            </FormField>
          </ColumnLayout>
        </Container>

        {/* Package characteristics (without shopping) */}
        <Container header={<Header variant="h2">패키지 특성</Header>}>
          <ColumnLayout columns={2}>
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
                          HOTEL_GRADES.find((h) => h.value === hotelGrade)
                            ?.label || hotelGrade,
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

        {/* Additional requests (without budget) */}
        <Container header={<Header variant="h2">추가 요구사항</Header>}>
          <SpaceBetween size="m">
            <FormField label="타겟 고객">
              <Input
                value={targetCustomer}
                onChange={({ detail }) => setTargetCustomer(detail.value)}
                placeholder="예: 30대 커플, 가족 (아이 2명)"
              />
            </FormField>

            <FormField
              label="자유 텍스트 요청"
              description="추가로 원하는 조건이나 요구사항을 자유롭게 입력하세요."
            >
              <Textarea
                value={naturalLanguageRequest}
                onChange={({ detail }) =>
                  setNaturalLanguageRequest(detail.value)
                }
                placeholder="예: 야경 명소 위주로 구성, 도보 이동 최소화"
                rows={3}
              />
            </FormField>
          </SpaceBetween>
        </Container>

        {/* Progress bar — full form width, sits right above the submit button. */}
        {showProgress && progress && (
          <ProgressBar
            status={progress.status}
            step={progress.step}
            percent={progress.percent}
            errorMessage={progress.errorMessage}
          />
        )}
      </SpaceBetween>
    </Form>
  );
}
