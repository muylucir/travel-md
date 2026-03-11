"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Button from "@cloudscape-design/components/button";
import Select, { SelectProps } from "@cloudscape-design/components/select";
import FormField from "@cloudscape-design/components/form-field";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Box from "@cloudscape-design/components/box";
import Flashbar, { FlashbarProps } from "@cloudscape-design/components/flashbar";
import ProgressBar from "@cloudscape-design/components/progress-bar";
import Spinner from "@cloudscape-design/components/spinner";
import {
  useTrends,
  getTrendStatus,
  getFreshnessDays,
  TrendStatus,
} from "@/hooks/useTrends";
import { useTrendCollector } from "@/hooks/useTrendCollector";
import TrendBubbleChart from "./TrendBubbleChart";
import TrendTable from "./TrendTable";

const OVERVIEW_OPTION: SelectProps.Option = {
  value: "",
  label: "전체 (오버뷰)",
};

export default function TrendDashboard() {
  const [selectedCountry, setSelectedCountry] =
    useState<SelectProps.Option | null>(OVERVIEW_OPTION);
  const [cityOptions, setCityOptions] = useState<SelectProps.Option[]>([]);
  const [selectedCity, setSelectedCity] =
    useState<SelectProps.Option | null>(null);
  const [flashItems, setFlashItems] = useState<
    FlashbarProps.MessageDefinition[]
  >([]);

  const { trends, loading, error, fetchTrends } = useTrends();
  const {
    collecting,
    result: collectResult,
    error: collectError,
    progress: collectProgress,
    currentTool,
    collect,
  } = useTrendCollector();

  const countryValue = selectedCountry?.value || "";
  const cityValue = selectedCity?.value || "";
  const isOverview = !countryValue;

  // Country options from Graph Country nodes
  const [countryOptions, setCountryOptions] = useState<SelectProps.Option[]>([OVERVIEW_OPTION]);

  useEffect(() => {
    fetch("/api/graph/countries")
      .then((r) => r.json())
      .then((countries: string[]) => {
        const opts = countries.map((c) => ({ value: c, label: c }));
        setCountryOptions([OVERVIEW_OPTION, ...opts]);
      })
      .catch(() => {});
  }, []);

  // Fetch cities when country changes (from Graph City nodes)
  useEffect(() => {
    setSelectedCity(null);
    setCityOptions([]);
    if (!countryValue) return;
    fetch(`/api/graph/cities?country=${encodeURIComponent(countryValue)}`)
      .then((r) => r.json())
      .then((cities: Array<{ name: string }>) => {
        const opts = cities.map((c) => ({ value: c.name, label: c.name }));
        setCityOptions(opts);
      })
      .catch(() => {});
  }, [countryValue]);

  // Fetch trends when selection changes
  useEffect(() => {
    if (isOverview) {
      fetchTrends();
    } else if (cityValue) {
      fetchTrends({ country: countryValue, city: cityValue });
    } else {
      fetchTrends({ country: countryValue });
    }
  }, [isOverview, countryValue, cityValue, fetchTrends]);

  // Collection result flashbar
  useEffect(() => {
    if (collectResult) {
      const count = collectResult.summary?.trends_collected ?? "?";
      setFlashItems([
        {
          type: "success",
          content: `${count}개 트렌드 수집 완료 (${collectResult.elapsed_seconds}초)`,
          dismissible: true,
          onDismiss: () => setFlashItems([]),
          id: "collect-success",
        },
      ]);
      if (countryValue) fetchTrends({ country: countryValue, city: cityValue || undefined });
      else fetchTrends();
    }
  }, [collectResult, countryValue, fetchTrends]);

  useEffect(() => {
    if (collectError) {
      setFlashItems([
        {
          type: "error",
          content: `수집 실패: ${collectError}`,
          dismissible: true,
          onDismiss: () => setFlashItems([]),
          id: "collect-error",
        },
      ]);
    }
  }, [collectError]);

  const handleCollect = useCallback(() => {
    if (!countryValue) return;
    setFlashItems([]);
    collect(countryValue, cityValue || undefined);
  }, [countryValue, cityValue, collect]);

  // Summary stats
  const trendCount = trends.length;
  const latestDate = trends.length
    ? trends
        .reduce(
          (latest, t) => (t.date > latest ? t.date : latest),
          trends[0].date
        )
        .slice(0, 10)
    : "-";
  const avgFreshness = trends.length
    ? Math.round(
        trends.reduce((sum, t) => sum + getFreshnessDays(t.date), 0) /
          trends.length
      )
    : 0;

  // Status breakdown for overview
  const statusCounts = useMemo(() => {
    const counts: Record<TrendStatus, number> = {
      hot: 0,
      steady: 0,
      seasonal: 0,
      emerging: 0,
      stale: 0,
    };
    for (const t of trends) {
      counts[getTrendStatus(t)]++;
    }
    return counts;
  }, [trends]);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={
            isOverview
              ? "전체 트렌드 현황을 확인합니다. 수집하려면 국가를 선택하세요."
              : `${countryValue}${cityValue ? ` > ${cityValue}` : ""} 트렌드 현황`
          }
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                iconName="refresh"
                onClick={() =>
                  countryValue ? fetchTrends({ country: countryValue }) : fetchTrends()
                }
                loading={loading}
              >
                새로고침
              </Button>
              <Button
                variant="primary"
                onClick={handleCollect}
                loading={collecting}
                disabled={isOverview}
                iconName="add-plus"
              >
                트렌드 수집
              </Button>
            </SpaceBetween>
          }
        >
          트렌드 관리
        </Header>
      }
    >
      <SpaceBetween size="l">
        {collecting && (
          <Container>
            <ProgressBar
              value={collectProgress?.percent ?? 0}
              label={`${countryValue} 수집: ${currentTool ?? collectProgress?.step ?? "준비 중..."}`}
              description={`${collectProgress?.percent ?? 0}% 완료`}
              status="in-progress"
            />
          </Container>
        )}
        <Flashbar items={flashItems} />

        {/* Country + City filter */}
        <Container>
          <ColumnLayout columns={2}>
            <FormField label="국가">
              <Select
                selectedOption={selectedCountry}
                onChange={({ detail }) => {
                  setSelectedCountry(detail.selectedOption);
                  setSelectedCity(null);
                }}
                options={countryOptions}
                placeholder="국가 선택"
              />
            </FormField>
            <FormField label="도시 (선택)">
              <Select
                selectedOption={selectedCity}
                onChange={({ detail }) =>
                  setSelectedCity(detail.selectedOption)
                }
                options={cityOptions}
                placeholder={countryValue ? "도시 필터 (선택)" : "국가를 먼저 선택하세요"}
                disabled={!countryValue}
              />
            </FormField>
          </ColumnLayout>
        </Container>

        {/* Summary cards */}
        <Container header={<Header variant="h2">트렌드 현황</Header>}>
          {isOverview ? (
            <ColumnLayout columns={5} variant="text-grid">
              <div>
                <Box variant="awsui-key-label">전체 트렌드</Box>
                <Box variant="awsui-value-large">
                  {loading ? <Spinner /> : `${trendCount}개`}
                </Box>
              </div>
              <div>
                <Box variant="awsui-key-label">핫</Box>
                <Box variant="awsui-value-large">
                  {loading ? (
                    <Spinner />
                  ) : (
                    <span style={{ color: "#d13212" }}>
                      {statusCounts.hot}개
                    </span>
                  )}
                </Box>
              </div>
              <div>
                <Box variant="awsui-key-label">스테디</Box>
                <Box variant="awsui-value-large">
                  {loading ? (
                    <Spinner />
                  ) : (
                    <span style={{ color: "#0972d3" }}>
                      {statusCounts.steady}개
                    </span>
                  )}
                </Box>
              </div>
              <div>
                <Box variant="awsui-key-label">시즌</Box>
                <Box variant="awsui-value-large">
                  {loading ? (
                    <Spinner />
                  ) : (
                    <span style={{ color: "#e07941" }}>
                      {statusCounts.seasonal}개
                    </span>
                  )}
                </Box>
              </div>
              <div>
                <Box variant="awsui-key-label">갱신필요</Box>
                <Box variant="awsui-value-large">
                  {loading ? (
                    <Spinner />
                  ) : (
                    <span style={{ color: "#8d9096" }}>
                      {statusCounts.stale}개
                    </span>
                  )}
                </Box>
              </div>
            </ColumnLayout>
          ) : (
            <ColumnLayout columns={3} variant="text-grid">
              <div>
                <Box variant="awsui-key-label">평균 Freshness</Box>
                <Box variant="awsui-value-large">
                  {loading ? <Spinner /> : `${avgFreshness}일 전`}
                </Box>
              </div>
              <div>
                <Box variant="awsui-key-label">트렌드 수</Box>
                <Box variant="awsui-value-large">
                  {loading ? <Spinner /> : `${trendCount}개`}
                </Box>
              </div>
              <div>
                <Box variant="awsui-key-label">마지막 수집</Box>
                <Box variant="awsui-value-large">
                  {loading ? <Spinner /> : latestDate}
                </Box>
              </div>
            </ColumnLayout>
          )}
        </Container>

        {/* Bubble chart */}
        <Container header={<Header variant="h2">버블차트</Header>}>
          {loading ? (
            <Box textAlign="center" padding="xl">
              <Spinner size="large" />
            </Box>
          ) : trends.length > 0 ? (
            <TrendBubbleChart trends={trends} />
          ) : (
            <Box textAlign="center" padding="l" color="inherit">
              {error
                ? `오류: ${error}`
                : isOverview
                  ? "등록된 트렌드가 없습니다."
                  : "데이터가 없습니다. 트렌드를 수집해주세요."}
            </Box>
          )}
        </Container>

        {/* Trend table */}
        <Container
          header={
            <Header variant="h2" counter={`(${trendCount})`}>
              트렌드 목록
            </Header>
          }
        >
          <TrendTable trends={trends} loading={loading} />
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}
