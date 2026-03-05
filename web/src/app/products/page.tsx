"use client";

import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import Alert from "@cloudscape-design/components/alert";
import AppLayout from "@/components/layout/AppLayout";
import ProductTable from "@/components/products/ProductTable";
import { useProducts } from "@/hooks/useProducts";

export default function ProductsPage() {
  const { products, loading, error, refresh, deleteProduct } = useProducts();

  return (
    <AppLayout contentType="table">
      <ContentLayout
        header={
          <Header
            variant="h1"
            description="AI 에이전트가 기획한 여행 상품 목록입니다."
          >
            기획 상품
          </Header>
        }
      >
        {error && (
          <Alert type="error" dismissible onDismiss={() => {}}>
            {error}
          </Alert>
        )}
        <ProductTable
          products={products}
          loading={loading}
          onRefresh={refresh}
          onDelete={deleteProduct}
        />
      </ContentLayout>
    </AppLayout>
  );
}
