"use client";

import { useState, useCallback, useEffect } from "react";
import type { PlanningOutput } from "@/lib/types";

export interface UseProductsReturn {
  products: PlanningOutput[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  deleteProduct: (code: string) => Promise<void>;
}

export function useProducts(): UseProductsReturn {
  const [products, setProducts] = useState<PlanningOutput[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/products?limit=50");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProducts(data.products || []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "상품 목록 조회 실패"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const deleteProduct = useCallback(
    async (code: string) => {
      try {
        const res = await fetch(`/api/products/${encodeURIComponent(code)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setProducts((prev) => prev.filter((p) => p.product_code !== code));
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "상품 삭제 실패"
        );
      }
    },
    []
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { products, loading, error, refresh, deleteProduct };
}
