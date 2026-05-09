"use client";

import { useState, useCallback } from "react";
import type { PackageNode } from "@/lib/types";

export interface PackageFilters {
  destination?: string;
  /** v3 Theme.key (e.g. FAMILY_WITH_KIDS, FOODIE) */
  theme_key?: string;
  /** Season.quarter 1..4 */
  season_quarter?: number;
  nights?: number;
  /** v3 Brand: "세이브" | "스탠다드" */
  brand?: string;
  limit?: number;
}

export interface UsePackagesReturn {
  packages: PackageNode[];
  loading: boolean;
  error: string | null;
  refresh: (filters?: PackageFilters) => Promise<void>;
}

export function usePackages(): UsePackagesReturn {
  const [packages, setPackages] = useState<PackageNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (filters?: PackageFilters) => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      const f = filters || {};

      if (f.destination) params.set("destination", f.destination);
      if (f.theme_key) params.set("theme_key", f.theme_key);
      if (f.season_quarter) params.set("season_quarter", String(f.season_quarter));
      if (f.nights) params.set("nights", String(f.nights));
      if (f.brand) params.set("brand", f.brand);
      if (f.limit) params.set("limit", String(f.limit));

      const queryString = params.toString();
      const url = `/api/packages${queryString ? `?${queryString}` : ""}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      setPackages(Array.isArray(data) ? data : []);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "패키지 목록을 불러올 수 없습니다.";
      setError(message);
      setPackages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  return { packages, loading, error, refresh };
}
