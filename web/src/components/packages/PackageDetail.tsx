"use client";

import { useState, useEffect } from "react";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Box from "@cloudscape-design/components/box";
import Badge from "@cloudscape-design/components/badge";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import Header from "@cloudscape-design/components/header";
import Container from "@cloudscape-design/components/container";

interface PackageDetailProps {
  packageCode: string;
  packageName: string;
  visible: boolean;
  onDismiss: () => void;
}

interface DetailData {
  package: Record<string, unknown>;
  cities: Record<string, unknown>[];
  attractions: Record<string, unknown>[];
  hotels: Record<string, unknown>[];
  routes: Record<string, unknown>[];
  themes: Record<string, unknown>[];
}

export default function PackageDetail({
  packageCode,
  packageName,
  visible,
  onDismiss,
}: PackageDetailProps) {
  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !packageCode) return;

    setLoading(true);
    setError(null);

    fetch(`/api/packages/${encodeURIComponent(packageCode)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        setData(json);
      })
      .catch((err) => {
        setError(err.message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [visible, packageCode]);

  const val = (obj: Record<string, unknown>, key: string): string => {
    const v = obj[key];
    if (Array.isArray(v)) return String(v[0] ?? "");
    return String(v ?? "");
  };

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={packageName}
      size="large"
    >
      {loading && (
        <Box textAlign="center" padding="xxl">
          <Spinner size="large" />
          <Box variant="p" padding={{ top: "s" }}>
            패키지 상세 정보를 불러오는 중...
          </Box>
        </Box>
      )}

      {error && (
        <Box textAlign="center" color="text-status-error" padding="l">
          오류: {error}
        </Box>
      )}

      {data && !loading && (
        <SpaceBetween size="l">
          {/* Package Info */}
          <Container header={<Header variant="h3">기본 정보</Header>}>
            <ColumnLayout columns={4} variant="text-grid">
              <div>
                <Box variant="awsui-key-label">상품 코드</Box>
                <Box variant="p">{val(data.package, "code")}</Box>
              </div>
              <div>
                <Box variant="awsui-key-label">가격</Box>
                <Box variant="p">
                  {Number(val(data.package, "price")).toLocaleString()}원
                </Box>
              </div>
              <div>
                <Box variant="awsui-key-label">일정</Box>
                <Box variant="p">
                  {val(data.package, "nights")}박{" "}
                  {val(data.package, "days")}일
                </Box>
              </div>
              <div>
                <Box variant="awsui-key-label">평점</Box>
                <Box variant="p">{val(data.package, "rating")}</Box>
              </div>
            </ColumnLayout>
          </Container>

          {/* Cities */}
          {data.cities.length > 0 && (
            <Container header={<Header variant="h3">방문 도시</Header>}>
              <SpaceBetween size="xs" direction="horizontal">
                {data.cities.map((city, idx) => (
                  <Badge key={idx} color="blue">
                    {val(city, "name")} ({val(city, "region")})
                  </Badge>
                ))}
              </SpaceBetween>
            </Container>
          )}

          {/* Attractions */}
          {data.attractions.length > 0 && (
            <Table
              header={
                <Header variant="h3">
                  관광지 ({data.attractions.length})
                </Header>
              }
              columnDefinitions={[
                {
                  id: "name",
                  header: "관광지명",
                  cell: (item) => val(item, "name"),
                },
                {
                  id: "category",
                  header: "카테고리",
                  cell: (item) => val(item, "category"),
                },
                {
                  id: "description",
                  header: "설명",
                  cell: (item) => val(item, "description"),
                },
              ]}
              items={data.attractions}
              variant="embedded"
            />
          )}

          {/* Hotels */}
          {data.hotels.length > 0 && (
            <Table
              header={
                <Header variant="h3">
                  호텔 ({data.hotels.length})
                </Header>
              }
              columnDefinitions={[
                {
                  id: "name",
                  header: "호텔명",
                  cell: (item) =>
                    val(item, "name_ko") || val(item, "name_en"),
                },
                {
                  id: "grade",
                  header: "등급",
                  cell: (item) => val(item, "grade"),
                },
                {
                  id: "onsen",
                  header: "온천",
                  cell: (item) =>
                    val(item, "has_onsen") === "true" ? "있음" : "없음",
                },
                {
                  id: "amenities",
                  header: "부대시설",
                  cell: (item) => val(item, "amenities"),
                },
              ]}
              items={data.hotels}
              variant="embedded"
            />
          )}

          {/* Routes */}
          {data.routes.length > 0 && (
            <Table
              header={
                <Header variant="h3">
                  항공편 ({data.routes.length})
                </Header>
              }
              columnDefinitions={[
                {
                  id: "flight",
                  header: "편명",
                  cell: (item) => val(item, "flight_number"),
                },
                {
                  id: "airline",
                  header: "항공사",
                  cell: (item) => val(item, "airline"),
                },
                {
                  id: "route",
                  header: "구간",
                  cell: (item) =>
                    `${val(item, "departure_city")} → ${val(item, "arrival_city")}`,
                },
                {
                  id: "time",
                  header: "시간",
                  cell: (item) =>
                    `${val(item, "departure_time")} → ${val(item, "arrival_time")}`,
                },
                {
                  id: "duration",
                  header: "소요시간",
                  cell: (item) => val(item, "duration"),
                },
              ]}
              items={data.routes}
              variant="embedded"
            />
          )}

          {/* Themes */}
          {data.themes.length > 0 && (
            <Container header={<Header variant="h3">테마</Header>}>
              <SpaceBetween size="xs" direction="horizontal">
                {data.themes.map((theme, idx) => (
                  <Badge key={idx}>{val(theme, "name")}</Badge>
                ))}
              </SpaceBetween>
            </Container>
          )}
        </SpaceBetween>
      )}
    </Modal>
  );
}
