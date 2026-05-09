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
              flex: "1 1 200px",
              maxWidth: 260,
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
            <div style={{ fontSize: 12, marginBottom: 4 }}>
              <span style={{ fontWeight: 500 }}>
                {pkg.nights}박{pkg.days}일
              </span>
              {pkg.brand && (
                <span
                  style={{
                    marginLeft: 6,
                    padding: "1px 6px",
                    borderRadius: 10,
                    fontSize: 11,
                    background:
                      pkg.brand === "세이브" ? "#fff3cd" : "#e2e3e5",
                    color: pkg.brand === "세이브" ? "#856404" : "#495057",
                  }}
                >
                  {pkg.brand}
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
            {pkg.description && (
              <div
                style={{
                  fontSize: 11,
                  color: "#545b64",
                  marginTop: 6,
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
                title={pkg.description}
              >
                {pkg.description}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
