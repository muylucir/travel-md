"use client";

import Spinner from "@cloudscape-design/components/spinner";
import Box from "@cloudscape-design/components/box";
import type { PackageNode } from "@/lib/types";

interface RecommendedPackageCardsProps {
  packages: PackageNode[];
  loading: boolean;
  error: string | null;
  selectedCode: string;
  onSelect: (code: string) => void;
}

export default function RecommendedPackageCards({
  packages,
  loading,
  error,
  selectedCode,
  onSelect,
}: RecommendedPackageCardsProps) {
  if (loading) {
    return (
      <Box textAlign="center" padding="s">
        <Spinner size="normal" /> 추천 상품 검색 중...
      </Box>
    );
  }

  if (error) {
    return (
      <Box color="text-status-error" padding="s">
        추천 상품 조회 실패: {error}
      </Box>
    );
  }

  if (packages.length === 0) {
    return (
      <Box color="text-status-inactive" padding="s">
        조건에 맞는 추천 상품이 없습니다.
      </Box>
    );
  }

  const displayed = packages.slice(0, 5);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      {displayed.map((pkg) => {
        const isSelected = selectedCode === pkg.code;
        return (
          <div
            key={pkg.code}
            onClick={() => onSelect(isSelected ? "" : pkg.code)}
            style={{
              flex: "1 1 180px",
              maxWidth: 240,
              border: isSelected ? "2px solid #0972d3" : "1px solid #e0e0e0",
              borderRadius: 8,
              padding: 12,
              cursor: "pointer",
              backgroundColor: isSelected ? "#f0f8ff" : "#fff",
              transition: "all 0.15s ease",
            }}
          >
            <div
              style={{
                fontWeight: 600,
                fontSize: 13,
                marginBottom: 4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={pkg.name}
            >
              {pkg.name}
            </div>
            <div style={{ fontSize: 11, color: "#687078", marginBottom: 6 }}>
              {pkg.code}
            </div>
            <div style={{ fontSize: 12, marginBottom: 2 }}>
              <span style={{ fontWeight: 500 }}>
                {pkg.price > 0 ? `${pkg.price.toLocaleString()}원` : "-"}
              </span>
              {pkg.rating > 0 && (
                <span style={{ marginLeft: 8, color: "#e89e0d" }}>
                  ★ {pkg.rating.toFixed(1)}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "#555", marginBottom: 2 }}>
              {pkg.nights}박{pkg.days}일
              {pkg.shopping_count !== undefined && pkg.shopping_count >= 0 && (
                <span style={{ marginLeft: 6 }}>
                  · 쇼핑 {pkg.shopping_count}회
                </span>
              )}
            </div>
            {pkg.travel_cities && (
              <div
                style={{
                  fontSize: 11,
                  color: "#0972d3",
                  marginTop: 4,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={pkg.travel_cities}
              >
                {pkg.travel_cities}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
