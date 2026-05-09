"use client";

import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Box from "@cloudscape-design/components/box";
import Table from "@cloudscape-design/components/table";
import Badge from "@cloudscape-design/components/badge";
import {
  NODE_TYPE_COLORS,
  V3_VERTEX_INFO,
  V3_EDGE_INFO,
} from "@/lib/types";

/**
 * v3 그래프 스키마 개요.
 *
 * 출처: v3-graph-package/04_docs/SCHEMA_REFERENCE.md (2026-05-06)
 * 운영 모집단: 간사이 4도시 (OSA / UKY / UKB / ARN)
 * 카운트: 6,691 정점 / 30,108 엣지
 */
export default function SchemaOverview() {
  const vertexRows = Object.entries(V3_VERTEX_INFO).map(([label, meta]) => ({
    label,
    ...meta,
  }));

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description="간사이 4도시 (OSA·UKY·UKB·ARN) · 6,691 정점 / 30,108 엣지"
          >
            v3 그래프 스키마 개요
          </Header>
        }
      >
        <ColumnLayout columns={3} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">정점 라벨</Box>
            <Box variant="awsui-value-large">15</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">엣지 라벨</Box>
            <Box variant="awsui-value-large">20</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">가중 엣지</Box>
            <Box variant="awsui-value-large">7</Box>
          </div>
        </ColumnLayout>
      </Container>

      <Container
        header={
          <Header
            variant="h2"
            description="라벨, 인스턴스 수, 모집단 정의, ID 패턴"
          >
            정점 (15)
          </Header>
        }
      >
        <Table
          items={vertexRows}
          columnDefinitions={[
            {
              id: "label",
              header: "라벨",
              cell: (item) => (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: NODE_TYPE_COLORS[item.label] || "#888",
                    }}
                  />
                  <strong>{item.label}</strong>
                </span>
              ),
            },
            {
              id: "count",
              header: "인스턴스",
              cell: (item) => item.count.toLocaleString(),
            },
            {
              id: "description",
              header: "모집단 정의",
              cell: (item) => item.description,
            },
            {
              id: "idPattern",
              header: "ID 패턴",
              cell: (item) => <code>{item.idPattern}</code>,
            },
          ]}
          variant="embedded"
          stickyHeader
        />
      </Container>

      <Container
        header={
          <Header
            variant="h2"
            description="가중치 표시 엣지는 추천 점수 함수의 핵심 신호"
          >
            엣지 (20)
          </Header>
        }
      >
        <Table
          items={[...V3_EDGE_INFO]}
          columnDefinitions={[
            {
              id: "label",
              header: "라벨",
              cell: (item) => (
                <strong>
                  {item.label}
                  {item.weighted && (
                    <Badge color="blue">
                      <span style={{ fontSize: 10 }}>weighted</span>
                    </Badge>
                  )}
                </strong>
              ),
            },
            {
              id: "count",
              header: "인스턴스",
              cell: (item) => item.count.toLocaleString(),
            },
            {
              id: "direction",
              header: "방향",
              cell: (item) => <code>{item.direction}</code>,
            },
          ]}
          variant="embedded"
          stickyHeader
        />
      </Container>

      <Container
        header={
          <Header
            variant="h3"
            description="간사이 4도시 운영 모집단을 만든 6가지 결정 (DECISIONS.md)"
          >
            적재 결정 (A1~A6)
          </Header>
        }
      >
        <SpaceBetween size="xs">
          <Box>
            <strong>A1</strong> — Attraction 정점은 간사이 4도시 ∧ 비-교통 ∧
            useYn=&apos;Y&apos; → 1,053건
          </Box>
          <Box>
            <strong>A2</strong> — Hotel 정점은 JP ∧ 간사이 4도시 → 4,389건
            (OSA 2,233 / UKY 1,864 / ARN 183 / UKB 109)
          </Box>
          <Box>
            <strong>A3</strong> — HotelStay.packageHotelId NULL 시 MATCHED_TO
            엣지 누락 허용 (192건 dangling, 172/364 엣지)
          </Box>
          <Box>
            <strong>A4</strong> — scheduled 78건 theme 가중치 누락 (Open) —
            도시 확장 시 우선 처리
          </Box>
          <Box>
            <strong>A5</strong> — IN_THEME 적재 시 교통/공항 제외 → 1,049 ×
            10 = 10,490 엣지
          </Box>
          <Box>
            <strong>A6</strong> — HotTrend / SteadyTrend placeholder 1개씩 +
            모든 1,053 어트랙션에 weight=0.0 / 1.0 시드. 실 분류기 도입 시
            weight UPDATE만으로 transparent 전환
          </Box>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
