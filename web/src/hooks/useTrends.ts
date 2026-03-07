import { useState, useCallback } from "react";

export interface TrendEvidence {
  source: string;
  title: string;
  url?: string;
  metric?: string;
}

export interface Trend {
  id: string;
  title: string;
  type: string;
  source: string;
  date: string;
  virality_score: number;
  decay_rate: number;
  keywords: string[];
  spots: TrendSpot[];
  effective_score: number;
  evidence?: TrendEvidence[];
}

export interface TrendSpot {
  id: string;
  name: string;
  description: string;
  category: string;
  lat: number;
  lng: number;
  photo_worthy: boolean;
}

export type TrendStatus = "hot" | "steady" | "emerging" | "stale";

export function getTrendStatus(trend: Trend): TrendStatus {
  const now = new Date();
  const trendDate = new Date(trend.date);
  const daysDiff = Math.floor(
    (now.getTime() - trendDate.getTime()) / (1000 * 60 * 60 * 24)
  );
  const fresh = daysDiff <= 14;
  const highViral = trend.virality_score >= 50;

  if (fresh && highViral) return "hot";
  if (!fresh && highViral) return "steady";
  if (fresh && !highViral) return "emerging";
  return "stale";
}

export function getStatusLabel(status: TrendStatus): string {
  const labels: Record<TrendStatus, string> = {
    hot: "핫",
    steady: "스테디",
    emerging: "신생",
    stale: "갱신필요",
  };
  return labels[status];
}

export function getStatusColor(
  status: TrendStatus
): "red" | "blue" | "green" | "grey" {
  const colors: Record<TrendStatus, "red" | "blue" | "green" | "grey"> = {
    hot: "red",
    steady: "blue",
    emerging: "green",
    stale: "grey",
  };
  return colors[status];
}

export function getFreshnessDays(dateStr: string): number {
  const now = new Date();
  const d = new Date(dateStr);
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

export function useTrends() {
  const [trends, setTrends] = useState<Trend[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Fetch trends. Filters: country, city, or region (legacy). All optional = overview. */
  const fetchTrends = useCallback(
    async (filters?: { country?: string; city?: string; region?: string }) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (filters?.city) params.set("city", filters.city);
        else if (filters?.region) params.set("region", filters.region);
        else if (filters?.country) params.set("country", filters.country);
        const qs = params.toString();
        const res = await fetch(`/api/graph/trends${qs ? `?${qs}` : ""}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setTrends(data.trends || []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
        setTrends([]);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  return { trends, loading, error, fetchTrends };
}
