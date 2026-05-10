"use client";

import { useEffect, useMemo, useState } from "react";
import FormField from "@cloudscape-design/components/form-field";
import Slider from "@cloudscape-design/components/slider";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Box from "@cloudscape-design/components/box";
import Badge from "@cloudscape-design/components/badge";

// Mirror of agent/src/similarity/layer_rules.py: compute_retain_ratio.
// Layer offsets sized so similarity=50 lands at the layer's nominal weight.
const LAYER_OFFSETS: Record<string, number> = {
  route: 0.45,
  hotel: 0.2,
  attraction: 0.0,
  activity: -0.2,
  theme: -0.4,
};

const LAYER_WEIGHTS: Record<string, number> = {
  route: 0.95,
  hotel: 0.7,
  attraction: 0.5,
  activity: 0.3,
  theme: 0.1,
};

function computeRetainRatio(similarity: number): Record<string, number> {
  const s = Math.max(0, Math.min(100, similarity)) / 100;
  return Object.fromEntries(
    Object.entries(LAYER_OFFSETS).map(([k, off]) => [
      k,
      Math.max(0, Math.min(1, s + off)),
    ])
  );
}

function keepCount(ratio: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(total, Math.round(total * ratio)));
}

interface ReferencePreview {
  cities: string[];
  hotels: string[];
  attractions: string[];
}

interface SimilaritySliderProps {
  value: number;
  onChange: (value: number) => void;
  referenceProductId?: string;
}

// Strip the package response into the slim shape we need for the preview.
function summarizePackage(pkg: unknown): ReferencePreview {
  const p = pkg as Record<string, unknown> | null | undefined;
  if (!p) return { cities: [], hotels: [], attractions: [] };

  const cities: string[] = [];
  const arr = p.arrivalCity as Record<string, unknown> | null | undefined;
  if (arr?.name) cities.push(String(arr.name));
  for (const c of (p.visitCities as Record<string, unknown>[]) || []) {
    const name = c?.name;
    if (typeof name === "string" && !cities.includes(name)) cities.push(name);
  }

  const hotels: string[] = [];
  const seenH = new Set<string>();
  for (const s of (p.hotelStays as Record<string, unknown>[]) || []) {
    const h = s?.hotel as Record<string, unknown> | null | undefined;
    const name =
      (h && typeof h.name === "string" && h.name) ||
      (typeof s?.locaDesc === "string" ? (s.locaDesc as string) : "");
    if (name && !seenH.has(name)) {
      seenH.add(name);
      hotels.push(name);
    }
  }

  const attractions: string[] = [];
  const seenA = new Set<string>();
  for (const a of (p.attractions as Record<string, unknown>[]) || []) {
    const name = a?.name;
    if (typeof name === "string" && !seenA.has(name)) {
      seenA.add(name);
      attractions.push(name);
    }
  }

  return { cities, hotels, attractions };
}

export default function SimilaritySlider({
  value,
  onChange,
  referenceProductId,
}: SimilaritySliderProps) {
  const [preview, setPreview] = useState<ReferencePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch reference details whenever the selected product code changes.
  useEffect(() => {
    if (!referenceProductId) {
      setPreview(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/packages/${encodeURIComponent(referenceProductId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setPreview(summarizePackage(data));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setPreview(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [referenceProductId]);

  const ratios = useMemo(() => computeRetainRatio(value), [value]);

  const counts = useMemo(() => {
    if (!preview) return null;
    return {
      cities: keepCount(ratios.route, preview.cities.length),
      hotels: keepCount(ratios.hotel, preview.hotels.length),
      attractions: keepCount(ratios.attraction, preview.attractions.length),
    };
  }, [ratios, preview]);

  return (
    <FormField
      label="유사도 (Similarity Level)"
      description="기준 상품 대비 새 상품의 유사 정도를 설정합니다. 슬라이더를 움직이면 어떤 요소가 유지/신규로 바뀌는지 즉시 확인할 수 있습니다."
    >
      <SpaceBetween size="s">
        <Slider
          value={value}
          onChange={({ detail }) => onChange(detail.value)}
          min={0}
          max={100}
          step={5}
          valueFormatter={(v) => `${v}%`}
        />

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            color: "#687078",
            padding: "0 4px",
          }}
        >
          <span>0% (완전 신규)</span>
          <span>50% (테마 변경)</span>
          <span>100% (리브랜딩)</span>
        </div>

        {/* Per-layer gradient bar — width reflects retain ratio */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {(
            [
              { key: "route", label: "L1 노선·도시" },
              { key: "hotel", label: "L2 숙박" },
              { key: "attraction", label: "L3 핵심 명소" },
              { key: "activity", label: "L4 액티비티" },
              { key: "theme", label: "L5 테마" },
            ] as const
          ).map(({ key, label }) => {
            const ratio = ratios[key];
            const pct = Math.round(ratio * 100);
            const weight = LAYER_WEIGHTS[key];
            return (
              <div
                key={key}
                style={{
                  display: "grid",
                  gridTemplateColumns: "120px 1fr 60px",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                }}
              >
                <span style={{ color: "#414d5c" }}>
                  {label}{" "}
                  <span style={{ color: "#687078", fontSize: 10 }}>
                    (w={weight.toFixed(2)})
                  </span>
                </span>
                <div
                  style={{
                    height: 10,
                    backgroundColor: "#eaeded",
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      backgroundColor:
                        pct >= 75
                          ? "#0f5132"
                          : pct >= 40
                          ? "#0972d3"
                          : "#d13212",
                      transition: "width 120ms ease-out",
                    }}
                  />
                </div>
                <span
                  style={{
                    color: "#414d5c",
                    fontSize: 11,
                    textAlign: "right",
                  }}
                >
                  {pct}% 보존
                </span>
              </div>
            );
          })}
        </div>

        {/* Concrete preview when a reference product is selected */}
        {referenceProductId && (
          <Box variant="div" margin={{ top: "xs" }}>
            {loading && (
              <Box variant="small" color="text-body-secondary">
                기준 상품 정보를 불러오는 중...
              </Box>
            )}
            {error && (
              <Box variant="small" color="text-status-error">
                기준 상품을 불러오지 못했습니다. ({error})
              </Box>
            )}
            {!loading && !error && preview && counts && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                  marginTop: 8,
                }}
              >
                <PreviewBox
                  title="유지될 요소 (이름 그대로 사용)"
                  color="#0f5132"
                  bg="#d1e7dd"
                  border="#badbcc"
                  rows={[
                    {
                      label: "도시",
                      kept: counts.cities,
                      total: preview.cities.length,
                      names: preview.cities.slice(0, counts.cities),
                    },
                    {
                      label: "호텔",
                      kept: counts.hotels,
                      total: preview.hotels.length,
                      names: preview.hotels.slice(0, counts.hotels),
                    },
                    {
                      label: "핵심 명소",
                      kept: counts.attractions,
                      total: preview.attractions.length,
                      names: preview.attractions.slice(0, counts.attractions),
                    },
                  ]}
                />
                <ChangeBox
                  rows={[
                    {
                      label: "도시",
                      count: preview.cities.length - counts.cities,
                    },
                    {
                      label: "호텔",
                      count: preview.hotels.length - counts.hotels,
                    },
                    {
                      label: "명소",
                      count: preview.attractions.length - counts.attractions,
                    },
                  ]}
                />
              </div>
            )}
          </Box>
        )}

        {!referenceProductId && (
          <Badge color="grey">
            기준 상품을 선택하면 유지/신규 요소를 미리 볼 수 있습니다
          </Badge>
        )}
      </SpaceBetween>
    </FormField>
  );
}

function ChangeBox({
  rows,
}: {
  rows: { label: string; count: number }[];
}) {
  // Intentionally avoid showing concrete names here. The slider's promise is
  // "how many slots will be replaced", not "what specifically will replace
  // them". Actual replacements are picked by the LLM + graph-score later, so
  // surfacing names would be misleading.
  return (
    <div
      style={{
        backgroundColor: "#cff4fc",
        border: "1px solid #b6effb",
        borderRadius: 6,
        padding: "10px 12px",
        color: "#055160",
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>
        변경 대상 (자유 재구성)
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "flex", gap: 8 }}>
            <span style={{ width: 64, opacity: 0.85 }}>{r.label}</span>
            <span style={{ fontWeight: 600 }}>
              {r.count > 0 ? `${r.count}개 변경` : "변경 없음"}
            </span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 6, opacity: 0.7, fontSize: 11 }}>
        실제 대체 항목은 자유 텍스트·테마·시즌 가중치로 LLM 이 선택합니다.
      </div>
    </div>
  );
}

function PreviewBox({
  title,
  color,
  bg,
  border,
  rows,
  subtitle,
}: {
  title: string;
  color: string;
  bg: string;
  border: string;
  rows: { label: string; kept: number; total: number; names: string[] }[];
  subtitle?: string;
}) {
  return (
    <div
      style={{
        backgroundColor: bg,
        border: `1px solid ${border}`,
        borderRadius: 6,
        padding: "10px 12px",
        color,
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>
        {title}
        {subtitle && (
          <span
            style={{ fontWeight: 400, fontSize: 11, marginLeft: 6, opacity: 0.7 }}
          >
            {subtitle}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "flex", gap: 8 }}>
            <span style={{ width: 64, opacity: 0.85 }}>{r.label}</span>
            <span style={{ width: 50, fontWeight: 600 }}>
              {r.kept}/{r.total}
            </span>
            <span
              style={{
                flex: 1,
                opacity: 0.9,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={r.names.join(", ")}
            >
              {r.names.length > 0 ? r.names.join(", ") : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
