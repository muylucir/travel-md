"use client";

import { useState, useEffect, useCallback } from "react";
import type { PackageNode } from "@/lib/types";

export interface PackageFilters {
  destination?: string;
  theme?: string;
  season?: string;
  nights?: number;
  limit?: number;
}

export interface UsePackagesReturn {
  packages: PackageNode[];
  loading: boolean;
  error: string | null;
  refresh: (filters?: PackageFilters) => Promise<void>;
}

export function usePackages(initialFilters?: PackageFilters): UsePackagesReturn {
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
      if (f.theme) params.set("theme", f.theme);
      if (f.season) params.set("season", f.season);
      if (f.nights) params.set("nights", String(f.nights));
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

  useEffect(() => {
    refresh(initialFilters);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { packages, loading, error, refresh };
}
