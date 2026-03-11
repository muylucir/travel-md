"use client";

import { useRouter } from "next/navigation";
import Table from "@cloudscape-design/components/table";
import Header from "@cloudscape-design/components/header";
import Button from "@cloudscape-design/components/button";
import Pagination from "@cloudscape-design/components/pagination";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import { useCollection } from "@cloudscape-design/collection-hooks";
import type { PlanningOutput } from "@/lib/types";

interface ProductTableProps {
  products: PlanningOutput[];
  loading: boolean;
  onRefresh: () => void;
  onDelete: (code: string) => void;
}

const PAGE_SIZE = 10;

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}`;
}

export default function ProductTable({
  products,
  loading,
  onRefresh,
  onDelete,
}: ProductTableProps) {
  const router = useRouter();

  const { items, collectionProps, paginationProps } = useCollection(products, {
    pagination: { pageSize: PAGE_SIZE },
    sorting: {
      defaultState: {
        sortingColumn: { sortingField: "generated_at" },
        isDescending: true,
      },
    },
  });

  return (
    <Table
      {...collectionProps}
      header={
        <Header
          variant="h2"
          counter={`(${products.length})`}
          actions={
            <Button iconName="refresh" onClick={onRefresh} loading={loading}>
              새로고침
            </Button>
          }
        >
          기획 상품 목록
        </Header>
      }
      pagination={<Pagination {...paginationProps} />}
      columnDefinitions={[
        {
          id: "product_code",
          header: "상품 코드",
          cell: (item) => (
            <Button
              variant="link"
              onClick={() => router.push(`/products/${item.product_code}`)}
            >
              {item.product_code}
            </Button>
          ),
          width: 180,
          sortingField: "product_code",
        },
        {
          id: "package_name",
          header: "상품명",
          cell: (item) => item.package_name,
          width: 250,
          sortingField: "package_name",
        },
        {
          id: "region",
          header: "지역",
          cell: (item) =>
            item.region ? (
              <Badge>{item.region}</Badge>
            ) : (
              "-"
            ),
          width: 100,
        },
        {
          id: "duration",
          header: "기간",
          cell: (item) =>
            item.duration || `${item.nights}박 ${item.days}일`,
          width: 100,
        },
        {
          id: "price",
          header: "성인 가격",
          cell: (item) =>
            item.pricing?.adult_price
              ? `${item.pricing.adult_price.toLocaleString()}원`
              : "-",
          width: 130,
          sortingField: "pricing.adult_price",
          sortingComparator: (a, b) =>
            (a.pricing?.adult_price ?? 0) - (b.pricing?.adult_price ?? 0),
        },
        {
          id: "similarity",
          header: "유사도",
          cell: (item) => `${item.similarity_score}%`,
          width: 80,
          sortingField: "similarity_score",
        },
        {
          id: "generated_at",
          header: "생성일시",
          cell: (item) =>
            item.generated_at ? formatDateTime(item.generated_at) : "-",
          width: 150,
          sortingField: "generated_at",
        },
        {
          id: "actions",
          header: "삭제",
          cell: (item) => (
            <Button
              variant="icon"
              iconName="remove"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(item.product_code);
              }}
            />
          ),
          width: 60,
        },
      ]}
      items={items}
      loading={loading}
      loadingText="기획 상품 불러오는 중..."
      empty={
        <Box textAlign="center" color="inherit">
          <SpaceBetween size="m">
            <b>기획 상품이 없습니다</b>
            <Box variant="p" color="text-body-secondary">
              상품 기획 페이지에서 새로운 상품을 기획해 보세요.
            </Box>
          </SpaceBetween>
        </Box>
      }
      variant="full-page"
      stickyHeader
    />
  );
}
