"use client";

import { useRouter } from "next/navigation";
import Table from "@cloudscape-design/components/table";
import Header from "@cloudscape-design/components/header";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import type { PlanningOutput } from "@/lib/types";

interface ProductTableProps {
  products: PlanningOutput[];
  loading: boolean;
  onRefresh: () => void;
  onDelete: (code: string) => void;
}

export default function ProductTable({
  products,
  loading,
  onRefresh,
  onDelete,
}: ProductTableProps) {
  const router = useRouter();

  return (
    <Table
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
        },
        {
          id: "similarity",
          header: "유사도",
          cell: (item) => `${item.similarity_score}%`,
          width: 80,
        },
        {
          id: "generated_at",
          header: "생성일",
          cell: (item) =>
            item.generated_at
              ? new Date(item.generated_at).toLocaleDateString("ko-KR")
              : "-",
          width: 110,
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
      items={products}
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
