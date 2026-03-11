"use client";

import { useState } from "react";
import Table from "@cloudscape-design/components/table";
import Box from "@cloudscape-design/components/box";
import Pagination from "@cloudscape-design/components/pagination";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Link from "@cloudscape-design/components/link";
import Badge from "@cloudscape-design/components/badge";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useCollection } from "@cloudscape-design/collection-hooks";
import {
  Trend,
  TrendEvidence,
  TrendStatus,
  getTrendStatus,
  getStatusLabel,
  getFreshnessDays,
} from "@/hooks/useTrends";

const STATUS_TYPE: Record<
  TrendStatus,
  "success" | "info" | "warning" | "stopped"
> = {
  hot: "success",
  steady: "info",
  seasonal: "warning",
  emerging: "warning",
  stale: "stopped",
};

const SOURCE_LABELS: Record<string, string> = {
  youtube: "YouTube",
  naver: "네이버",
  google_trends: "Google Trends",
  news: "뉴스",
};

const SOURCE_SHORT: Record<string, string> = {
  youtube: "YT",
  naver: "NV",
  google_trends: "GT",
  news: "NS",
};

function EvidencePanel({ evidence }: { evidence: TrendEvidence[] }) {
  if (!evidence || evidence.length === 0) {
    return (
      <Box color="text-status-inactive" fontSize="body-s">
        수집 근거 데이터가 없습니다.
      </Box>
    );
  }

  // Group by source
  const grouped: Record<string, TrendEvidence[]> = {};
  for (const e of evidence) {
    const src = e.source || "기타";
    if (!grouped[src]) grouped[src] = [];
    grouped[src].push(e);
  }

  return (
    <ColumnLayout columns={Object.keys(grouped).length} variant="text-grid">
      {Object.entries(grouped).map(([src, items]) => (
        <div key={src}>
          <Box variant="awsui-key-label" margin={{ bottom: "xxs" }}>
            {SOURCE_LABELS[src] || src}
          </Box>
          <SpaceBetween size="xxs">
            {items.map((item, idx) => (
              <div
                key={idx}
                style={{
                  fontSize: 13,
                  lineHeight: 1.5,
                  borderLeft: "2px solid #e9ebed",
                  paddingLeft: 8,
                }}
              >
                <div>
                  {item.url ? (
                    <Link
                      href={item.url}
                      external
                      fontSize="body-s"
                    >
                      {item.title}
                    </Link>
                  ) : (
                    item.title
                  )}
                </div>
                {item.metric && (
                  <Box color="text-status-inactive" fontSize="body-s">
                    {item.metric}
                  </Box>
                )}
              </div>
            ))}
          </SpaceBetween>
        </div>
      ))}
    </ColumnLayout>
  );
}

interface Props {
  trends: Trend[];
  loading: boolean;
}

const PAGE_SIZE = 15;

export default function TrendTable({ trends, loading }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { items, paginationProps, collectionProps } = useCollection(trends, {
    pagination: { pageSize: PAGE_SIZE },
    sorting: {},
  });

  return (
    <Table
      {...collectionProps}
      items={items}
      loading={loading}
      pagination={<Pagination {...paginationProps} />}
      loadingText="트렌드 로딩 중..."
      sortingDisabled
      variant="embedded"
      empty={
        <Box textAlign="center" color="inherit" padding="l">
          <b>트렌드가 없습니다</b>
          <Box variant="p" color="inherit">
            지역을 선택하고 트렌드를 수집해주세요.
          </Box>
        </Box>
      }
      columnDefinitions={[
        {
          id: "title",
          header: "제목",
          cell: (item) => {
            const hasEvidence =
              item.evidence && item.evidence.length > 0;
            const isExpanded = expandedId === item.id;
            return (
              <SpaceBetween size="xs">
                <span
                  onClick={() =>
                    setExpandedId(isExpanded ? null : item.id)
                  }
                  style={{
                    cursor: "pointer",
                    textDecoration: hasEvidence ? "underline dotted" : undefined,
                  }}
                  title={hasEvidence ? "클릭하여 수집 근거 보기" : undefined}
                >
                  {isExpanded ? "▾ " : hasEvidence ? "▸ " : ""}
                  {item.title}
                </span>
                {isExpanded && (
                  <div style={{ marginTop: 4 }}>
                    <ExpandableSection
                      defaultExpanded
                      headerText={`수집 근거 (${item.evidence?.length || 0}건)`}
                      variant="footer"
                    >
                      <EvidencePanel evidence={item.evidence || []} />
                    </ExpandableSection>
                  </div>
                )}
              </SpaceBetween>
            );
          },
          width: 320,
        },
        {
          id: "source",
          header: "소스",
          cell: (item) => SOURCE_SHORT[item.source] || item.source,
          width: 60,
        },
        {
          id: "type",
          header: "유형",
          cell: (item) => item.type,
          width: 80,
        },
        {
          id: "virality",
          header: "점수",
          cell: (item) => item.virality_score,
          width: 60,
        },
        {
          id: "decay",
          header: "감쇠",
          cell: (item) => item.decay_rate.toFixed(2),
          width: 60,
        },
        {
          id: "effective",
          header: "유효점수",
          cell: (item) => item.effective_score.toFixed(1),
          width: 80,
        },
        {
          id: "date",
          header: "날짜",
          cell: (item) => {
            const days = getFreshnessDays(item.date);
            return `${item.date.slice(0, 10)} (${days}일 전)`;
          },
          width: 160,
        },
        {
          id: "status",
          header: "상태",
          cell: (item) => {
            const status = getTrendStatus(item);
            return (
              <StatusIndicator type={STATUS_TYPE[status]}>
                {getStatusLabel(status)}
              </StatusIndicator>
            );
          },
          width: 100,
        },
        {
          id: "evidence-count",
          header: "근거",
          cell: (item) => {
            const count = item.evidence?.length || 0;
            return count > 0 ? (
              <Badge color="blue">{count}</Badge>
            ) : (
              <Box color="text-status-inactive">-</Box>
            );
          },
          width: 60,
        },
      ]}
    />
  );
}
