"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Button from "@cloudscape-design/components/button";
import Spinner from "@cloudscape-design/components/spinner";
import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import AppLayout from "@/components/layout/AppLayout";
import ProductDetail from "@/components/products/ProductDetail";
import type { PlanningOutput } from "@/lib/types";

export default function ProductDetailPage() {
  const params = useParams();
  const router = useRouter();
  const code = params.code as string;

  const [product, setProduct] = useState<PlanningOutput | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchProduct() {
      try {
        const res = await fetch(
          `/api/products/${encodeURIComponent(code)}`
        );
        if (!res.ok) {
          if (res.status === 404) {
            setError("상품을 찾을 수 없습니다.");
          } else {
            setError(`조회 오류 (${res.status})`);
          }
          return;
        }
        const data = await res.json();
        setProduct(data);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "상품 조회 실패"
        );
      } finally {
        setLoading(false);
      }
    }

    if (code) fetchProduct();
  }, [code]);

  if (loading) {
    return (
      <AppLayout>
        <ContentLayout header={<Header variant="h1">상품 상세</Header>}>
          <Box textAlign="center" padding="xxl">
            <Spinner size="large" />
          </Box>
        </ContentLayout>
      </AppLayout>
    );
  }

  if (error || !product) {
    return (
      <AppLayout>
        <ContentLayout header={<Header variant="h1">상품 상세</Header>}>
          <SpaceBetween size="m">
            <Alert type="error">{error || "상품 데이터가 없습니다."}</Alert>
            <Button onClick={() => router.push("/products")}>
              목록으로 돌아가기
            </Button>
          </SpaceBetween>
        </ContentLayout>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <ContentLayout
        header={
          <Header
            variant="h1"
            actions={
              <Button onClick={() => router.push("/products")}>
                목록으로 돌아가기
              </Button>
            }
            description={`상품 코드: ${product.product_code}`}
          >
            {product.package_name}
          </Header>
        }
      >
        <ProductDetail product={product} />
      </ContentLayout>
    </AppLayout>
  );
}
