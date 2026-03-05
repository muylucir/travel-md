"use client";

import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Box from "@cloudscape-design/components/box";
import Badge from "@cloudscape-design/components/badge";
import Table from "@cloudscape-design/components/table";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import ItineraryCard from "./ItineraryCard";
import type { PlanningOutput } from "@/lib/types";

interface ResultPanelProps {
  result: PlanningOutput;
}

export default function ResultPanel({ result }: ResultPanelProps) {
  return (
    <SpaceBetween size="l">
      {/* Product Header */}
      <Container
        header={
          <Header
            variant="h2"
            description={result.description}
            info={
              result.product_code ? (
                <Badge color="blue">{result.product_code}</Badge>
              ) : undefined
            }
          >
            {result.package_name}
          </Header>
        }
      >
        <SpaceBetween size="m">
          <ColumnLayout columns={4} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">여행 기간</Box>
              <Box variant="p">
                {result.duration || `${result.nights}박 ${result.days}일`}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">성인 가격</Box>
              <Box variant="p">
                {result.pricing?.adult_price
                  ? `${result.pricing.adult_price.toLocaleString()}원`
                  : "-"}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">항공사</Box>
              <Box variant="p">
                {result.airline || "-"}{" "}
                {result.airline_type && `(${result.airline_type})`}
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">유사도</Box>
              <Box variant="p">{result.similarity_score}%</Box>
            </div>
          </ColumnLayout>

          {/* Hashtags inline */}
          {result.hashtags && result.hashtags.length > 0 && (
            <SpaceBetween size="xs" direction="horizontal">
              {result.hashtags.map((tag, idx) => (
                <Badge key={idx} color="grey">
                  {tag.startsWith("#") ? tag : `#${tag}`}
                </Badge>
              ))}
            </SpaceBetween>
          )}
        </SpaceBetween>
      </Container>

      {/* Highlights */}
      {result.highlights && result.highlights.length > 0 && (
        <Container header={<Header variant="h3">하이라이트</Header>}>
          <SpaceBetween size="xs">
            {result.highlights.map((item, idx) => (
              <Box key={idx} variant="p">
                {idx + 1}. {item}
              </Box>
            ))}
          </SpaceBetween>
        </Container>
      )}

      {/* Pricing */}
      {result.pricing && (
        <Container header={<Header variant="h3">가격 정보</Header>}>
          <ColumnLayout columns={4} variant="text-grid">
            <div>
              <Box variant="awsui-key-label">성인</Box>
              <Box variant="p">
                {result.pricing.adult_price.toLocaleString()}원
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">아동</Box>
              <Box variant="p">
                {result.pricing.child_price.toLocaleString()}원
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">유아</Box>
              <Box variant="p">
                {result.pricing.infant_price.toLocaleString()}원
              </Box>
            </div>
            <div>
              <Box variant="awsui-key-label">1인실 추가</Box>
              <Box variant="p">
                {result.pricing.single_room_surcharge
                  ? `${result.pricing.single_room_surcharge.toLocaleString()}원`
                  : "-"}
              </Box>
            </div>
          </ColumnLayout>
        </Container>
      )}

      {/* Flights */}
      {(result.departure_flight || result.return_flight) && (
        <Container header={<Header variant="h3">항공편</Header>}>
          <Table
            columnDefinitions={[
              {
                id: "direction",
                header: "구분",
                cell: (item) => item.direction,
                width: 80,
              },
              {
                id: "date",
                header: "날짜",
                cell: (item) =>
                  item.date
                    ? `${item.date} (${item.day_of_week})`
                    : "-",
              },
              {
                id: "flight",
                header: "편명",
                cell: (item) => item.flight_number || "-",
              },
              {
                id: "time",
                header: "시간",
                cell: (item) =>
                  `${item.departure_time} → ${item.arrival_time}`,
              },
              {
                id: "duration",
                header: "소요시간",
                cell: (item) => item.duration || "-",
              },
            ]}
            items={[
              {
                direction: "출국",
                ...result.departure_flight,
              },
              {
                direction: "귀국",
                ...result.return_flight,
              },
            ]}
            variant="embedded"
          />
        </Container>
      )}

      {/* Itinerary */}
      {result.itinerary && result.itinerary.length > 0 && (
        <Container header={<Header variant="h3">상세 일정</Header>}>
          <SpaceBetween size="m">
            {result.itinerary.map((day) => (
              <ItineraryCard key={day.day} itinerary={day} />
            ))}
          </SpaceBetween>
        </Container>
      )}

      {/* Attractions Dictionary */}
      {result.attractions && result.attractions.length > 0 && (
        <ExpandableSection headerText="관광지 상세" variant="container">
          <Table
            columnDefinitions={[
              {
                id: "name",
                header: "관광지",
                cell: (item) => item.name,
                width: 200,
              },
              {
                id: "desc",
                header: "설명",
                cell: (item) => item.short_description,
              },
            ]}
            items={result.attractions}
            variant="embedded"
          />
        </ExpandableSection>
      )}

      {/* Hotels */}
      {result.hotels && result.hotels.length > 0 && (
        <Container header={<Header variant="h3">호텔</Header>}>
          <SpaceBetween size="xs">
            {result.hotels.map((hotel, idx) => (
              <Box key={idx} variant="p">
                {hotel}
              </Box>
            ))}
          </SpaceBetween>
        </Container>
      )}

      {/* Inclusions / Exclusions */}
      {((result.inclusions && result.inclusions.length > 0) ||
        (result.exclusions && result.exclusions.length > 0)) && (
        <ExpandableSection
          headerText="포함 / 불포함 사항"
          variant="container"
        >
          <ColumnLayout columns={2}>
            <div>
              <Box variant="awsui-key-label">포함 사항</Box>
              <SpaceBetween size="xxs">
                {(result.inclusions || []).map((item, idx) => (
                  <Box key={idx} variant="p">
                    [{item.category}] {item.detail}
                  </Box>
                ))}
              </SpaceBetween>
            </div>
            <div>
              <Box variant="awsui-key-label">불포함 사항</Box>
              <SpaceBetween size="xxs">
                {(result.exclusions || []).map((item, idx) => (
                  <Box key={idx} variant="p">
                    [{item.category}] {item.detail}
                  </Box>
                ))}
              </SpaceBetween>
            </div>
          </ColumnLayout>
        </ExpandableSection>
      )}

      {/* Package Info */}
      <ExpandableSection headerText="패키지 특성" variant="container">
        <ColumnLayout columns={3} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">쇼핑 횟수</Box>
            <Box variant="p">{result.shopping_count}회</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">가이드/기사 경비</Box>
            <Box variant="p">
              {result.guide_fee
                ? `${result.guide_fee.amount} ${result.guide_fee.currency}`
                : "-"}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">상품 라인</Box>
            <Box variant="p">{result.product_line || "-"}</Box>
          </div>
        </ColumnLayout>
      </ExpandableSection>

      {/* Changes Summary */}
      {result.changes_summary && (
        <ExpandableSection
          headerText="변경 내역 (Changes Summary)"
          variant="container"
        >
          <SpaceBetween size="m">
            {result.changes_summary.retained?.length > 0 && (
              <div>
                <Box variant="awsui-key-label">유지 항목</Box>
                <SpaceBetween size="xs">
                  {result.changes_summary.retained.map((item, idx) => (
                    <Box key={idx} variant="p">
                      {item}
                    </Box>
                  ))}
                </SpaceBetween>
              </div>
            )}
            {result.changes_summary.modified?.length > 0 && (
              <div>
                <Box variant="awsui-key-label">변경 항목</Box>
                <SpaceBetween size="xs">
                  {result.changes_summary.modified.map((item, idx) => (
                    <Box key={idx} variant="p" color="text-status-warning">
                      {item}
                    </Box>
                  ))}
                </SpaceBetween>
              </div>
            )}
            {result.changes_summary.trend_added?.length > 0 && (
              <div>
                <Box variant="awsui-key-label">트렌드 추가</Box>
                <SpaceBetween size="xs">
                  {result.changes_summary.trend_added.map((item, idx) => (
                    <Box key={idx} variant="p" color="text-status-info">
                      {item}
                    </Box>
                  ))}
                </SpaceBetween>
              </div>
            )}
            <ColumnLayout columns={2}>
              <div>
                <Box variant="awsui-key-label">적용 유사도</Box>
                <Box variant="p">
                  {result.changes_summary.similarity_applied}%
                </Box>
              </div>
              <div>
                <Box variant="awsui-key-label">변경된 레이어</Box>
                <SpaceBetween size="xs" direction="horizontal">
                  {(result.changes_summary.layers_modified || []).map(
                    (layer, idx) => (
                      <Badge key={idx}>{layer}</Badge>
                    )
                  )}
                </SpaceBetween>
              </div>
            </ColumnLayout>
          </SpaceBetween>
        </ExpandableSection>
      )}

      {/* Metadata */}
      <Container header={<Header variant="h3">기획 정보</Header>}>
        <ColumnLayout columns={3} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">참고 상품</Box>
            <Box variant="p">
              {result.reference_products?.length > 0
                ? result.reference_products.join(", ")
                : "없음"}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">트렌드 소스</Box>
            <Box variant="p">
              {result.trend_sources?.length > 0
                ? result.trend_sources.join(", ")
                : "없음"}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">생성 일시</Box>
            <Box variant="p">{result.generated_at || "-"}</Box>
          </div>
        </ColumnLayout>
      </Container>
    </SpaceBetween>
  );
}
