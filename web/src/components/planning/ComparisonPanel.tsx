"use client";

import { useEffect, useState, useMemo } from "react";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Badge from "@cloudscape-design/components/badge";
import Alert from "@cloudscape-design/components/alert";
import type { PlanningOutput, DayItinerary } from "@/lib/types";

// ─── 5-Layer 가중치 (layer_rules.py 와 동일) ───────────────────────────
const LAYER_WEIGHTS = {
  route: 0.95, // L1: 노선/도시
  hotel: 0.7, // L2: 숙박
  attraction: 0.5, // L3: 핵심 관광지
  activity: 0.3, // L4: 세부 액티비티
  theme: 0.1, // L5: 분위기/테마 — 비교 대상 데이터가 명확치 않아 일단 1.0(유지)로 가정
} as const;

/**
 * 두 set 의 Jaccard 유사도 (교집합 / 합집합).
 * 양쪽이 모두 비어 있으면 1 로 처리.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * 실제 유사도 계산.
 * - L1 route: 도시 set Jaccard
 * - L2 hotel: 호텔 set Jaccard
 * - L3 attraction: Day1~ 관광지 union set Jaccard (메인 명소 합산)
 * - L4 activity: Day-attraction 1:1 매칭 비율 (같은 Day 에 같은 명소가 있는지)
 * - L5 theme: 가시 데이터 부족 — 1.0 유지로 가정
 *
 * 가중 평균 = Σ(weight_i × similarity_i) / Σweight_i
 */
function computeActualSimilarity(input: {
  refCities: Set<string>;
  newCities: Set<string>;
  refHotels: Set<string>;
  newHotels: Set<string>;
  refAttractions: Set<string>;
  newAttractions: Set<string>;
  refDayMap: Map<number, string[]>;
  newDayMap: Map<number, string[]>;
}): {
  total: number;
  perLayer: Record<keyof typeof LAYER_WEIGHTS, number>;
} {
  const cityScore = jaccard(input.refCities, input.newCities);
  const hotelScore = jaccard(input.refHotels, input.newHotels);
  const attrScore = jaccard(input.refAttractions, input.newAttractions);

  // L4 activity: 같은 Day 에 같은 명소가 등장한 비율
  const allDays = new Set<number>([
    ...input.refDayMap.keys(),
    ...input.newDayMap.keys(),
  ]);
  let dayMatches = 0;
  let dayTotal = 0;
  for (const d of allDays) {
    const refSet = new Set(input.refDayMap.get(d) || []);
    const newSet = new Set(input.newDayMap.get(d) || []);
    if (refSet.size === 0 && newSet.size === 0) continue;
    dayTotal++;
    let inter = 0;
    for (const x of refSet) if (newSet.has(x)) inter++;
    const union = refSet.size + newSet.size - inter;
    dayMatches += union === 0 ? 1 : inter / union;
  }
  const activityScore = dayTotal === 0 ? 1 : dayMatches / dayTotal;

  const themeScore = 1; // 비교 데이터 없음 — 추후 brand/theme 비교 추가 가능

  const perLayer = {
    route: cityScore,
    hotel: hotelScore,
    attraction: attrScore,
    activity: activityScore,
    theme: themeScore,
  };

  let weighted = 0;
  let weightSum = 0;
  for (const [layer, w] of Object.entries(LAYER_WEIGHTS) as Array<
    [keyof typeof LAYER_WEIGHTS, number]
  >) {
    weighted += w * perLayer[layer];
    weightSum += w;
  }
  const total = weightSum > 0 ? weighted / weightSum : 0;

  return { total, perLayer };
}

const LAYER_LABELS_KO: Record<keyof typeof LAYER_WEIGHTS, string> = {
  route: "L1 도시",
  hotel: "L2 호텔",
  attraction: "L3 관광지",
  activity: "L4 일자별",
  theme: "L5 테마",
};

interface ReferencePackage {
  saleProduct: {
    saleProdCd?: string;
    saleProdNm?: string;
    brndNm?: string;
    trvlNgtCnt?: number;
    trvlDayCnt?: number;
    arrCityNm?: string;
    arrCityCd?: string;
  };
  arrivalCity: { name?: string; code?: string } | null;
  visitCities: Array<{ name?: string; code?: string }>;
  attractions: Array<{
    name?: string;
    schdDay?: number;
    schtExprSqc?: number;
  }>;
  hotelStays: Array<{
    schdDay?: number;
    hotel: { name?: string } | null;
    locaDesc?: string;
  }>;
}

interface ComparisonPanelProps {
  result: PlanningOutput;
  referenceCode: string;
}

export default function ComparisonPanel({
  result,
  referenceCode,
}: ComparisonPanelProps) {
  const [reference, setReference] = useState<ReferencePackage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!referenceCode) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/packages/${encodeURIComponent(referenceCode)}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data: ReferencePackage) => {
        if (!cancelled) setReference(data);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "조회 실패");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [referenceCode]);

  // ─── 비교 데이터 가공 ────────────────────────────────────────────────
  const refCities = useMemo(() => {
    if (!reference) return [];
    const set = new Set<string>();
    if (reference.arrivalCity?.name) set.add(reference.arrivalCity.name);
    for (const c of reference.visitCities)
      if (c.name) set.add(c.name);
    return Array.from(set);
  }, [reference]);

  const newCities = result.city_list || [];

  const cityDiff = useMemo(() => {
    const refSet = new Set(refCities);
    const newSet = new Set(newCities);
    return {
      added: newCities.filter((c) => !refSet.has(c)),
      removed: refCities.filter((c) => !newSet.has(c)),
      kept: newCities.filter((c) => refSet.has(c)),
    };
  }, [refCities, newCities]);

  // 일자별 관광지 매핑
  const refDayMap = useMemo(() => {
    const map = new Map<number, string[]>();
    if (!reference) return map;
    for (const a of reference.attractions) {
      if (typeof a.schdDay !== "number" || !a.name) continue;
      const list = map.get(a.schdDay) || [];
      list.push(a.name);
      map.set(a.schdDay, list);
    }
    return map;
  }, [reference]);

  const newDayMap = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const it of result.itinerary || []) {
      map.set(it.day, it.attractions || []);
    }
    return map;
  }, [result.itinerary]);

  const allDays = useMemo(() => {
    const set = new Set<number>([
      ...Array.from(refDayMap.keys()),
      ...Array.from(newDayMap.keys()),
    ]);
    return Array.from(set).sort((a, b) => a - b);
  }, [refDayMap, newDayMap]);

  const refHotels = useMemo(() => {
    if (!reference) return [] as string[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of reference.hotelStays) {
      const n = s.hotel?.name || s.locaDesc;
      if (n && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  }, [reference]);

  // 실제 유사도 — 5-Layer 가중치 기반
  const similarity = useMemo(() => {
    if (!reference) return null;
    const refAttrs = new Set<string>();
    for (const a of reference.attractions) if (a.name) refAttrs.add(a.name);
    const newAttrs = new Set<string>();
    for (const it of result.itinerary || [])
      for (const n of it.attractions || []) newAttrs.add(n);

    return computeActualSimilarity({
      refCities: new Set(refCities),
      newCities: new Set(newCities),
      refHotels: new Set(refHotels),
      newHotels: new Set(result.hotels || []),
      refAttractions: refAttrs,
      newAttractions: newAttrs,
      refDayMap,
      newDayMap,
    });
  }, [
    reference,
    refCities,
    newCities,
    refHotels,
    result.hotels,
    result.itinerary,
    refDayMap,
    newDayMap,
  ]);

  const targetSim = result.similarity_score ?? 0;
  const actualSim = similarity ? Math.round(similarity.total * 100) : 0;
  const gap = Math.abs(targetSim - actualSim);

  // ─── Render ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <Container header={<Header variant="h2">기준 상품 vs 생성된 상품</Header>}>
        <Box textAlign="center" padding="m">
          <Spinner /> 기준 상품 불러오는 중...
        </Box>
      </Container>
    );
  }

  if (error || !reference) {
    return (
      <Container header={<Header variant="h2">기준 상품 vs 생성된 상품</Header>}>
        <Box color="text-status-error" padding="m">
          {error || "기준 상품 정보를 불러올 수 없습니다."}
        </Box>
      </Container>
    );
  }

  const refSP = reference.saleProduct;

  return (
    <Container
      header={
        <Header variant="h2" description="조건이 어떻게 변경되었는지 비교">
          기준 상품 vs 생성된 상품
        </Header>
      }
    >
      <SpaceBetween size="m">
        {/* Header: 두 상품의 식별 정보 */}
        <ColumnLayout columns={2}>
          <Box>
            <Box variant="awsui-key-label">기준 상품</Box>
            <Box variant="h4">{refSP.saleProdNm || refSP.saleProdCd}</Box>
            <Box variant="small" color="text-body-secondary">
              {refSP.saleProdCd}
            </Box>
            <SpaceBetween size="xxs" direction="horizontal">
              {refSP.brndNm && <Badge color="blue">{refSP.brndNm}</Badge>}
              <Badge>
                {refSP.trvlNgtCnt}박{refSP.trvlDayCnt}일
              </Badge>
            </SpaceBetween>
          </Box>
          <Box>
            <Box variant="awsui-key-label">✨ 생성된 상품</Box>
            <Box variant="h4">{result.package_name}</Box>
            <Box variant="small" color="text-body-secondary">
              {result.product_code}
            </Box>
            <SpaceBetween size="xxs" direction="horizontal">
              {result.brand && <Badge color="green">{result.brand}</Badge>}
              <Badge>
                {result.nights}박{result.days}일
              </Badge>
            </SpaceBetween>
          </Box>
        </ColumnLayout>

        {/* 유사도: 요청 vs 실제 */}
        {similarity && (
          <Box>
            <ColumnLayout columns={2}>
              <Box>
                <Box variant="awsui-key-label">요청 유사도 (target)</Box>
                <Box variant="h3">{targetSim}%</Box>
                <Box variant="small" color="text-body-secondary">
                  슬라이더에서 입력한 값 (의도)
                </Box>
              </Box>
              <Box>
                <Box variant="awsui-key-label">실제 유사도 (actual)</Box>
                <Box
                  variant="h3"
                  color={
                    gap >= 30
                      ? "text-status-error"
                      : gap >= 15
                        ? "text-status-warning"
                        : "text-status-success"
                  }
                >
                  {actualSim}%
                </Box>
                <Box variant="small" color="text-body-secondary">
                  도시·호텔·관광지 set 일치율 가중평균
                </Box>
              </Box>
            </ColumnLayout>

            {/* 레이어별 일치율 */}
            <div
              style={{
                display: "flex",
                gap: 6,
                marginTop: 8,
                flexWrap: "wrap",
              }}
            >
              {(Object.keys(LAYER_WEIGHTS) as Array<keyof typeof LAYER_WEIGHTS>)
                .map((layer) => {
                  const score = similarity.perLayer[layer];
                  const pct = Math.round(score * 100);
                  const color =
                    score >= 0.8
                      ? "#0f5132"
                      : score >= 0.4
                        ? "#664d03"
                        : "#842029";
                  const bg =
                    score >= 0.8
                      ? "#d1e7dd"
                      : score >= 0.4
                        ? "#fff3cd"
                        : "#f8d7da";
                  return (
                    <span
                      key={layer}
                      style={{
                        padding: "4px 10px",
                        borderRadius: 12,
                        fontSize: 11,
                        background: bg,
                        color,
                        fontWeight: 500,
                      }}
                      title={`weight=${LAYER_WEIGHTS[layer]}`}
                    >
                      {LAYER_LABELS_KO[layer]} {pct}%
                    </span>
                  );
                })}
            </div>

            {gap >= 15 && (
              <Box margin={{ top: "s" }}>
                <Alert
                  type={gap >= 30 ? "warning" : "info"}
                  header={`요청 유사도(${targetSim}%)와 실제 유사도(${actualSim}%) 차이가 ${gap}%p 입니다`}
                >
                  요청한 유사도와 실제 변경 정도가 일치하지 않습니다. 가능한
                  원인:
                  <ul style={{ marginTop: 4, marginBottom: 0 }}>
                    <li>
                      도착 도시(destination)가 기준 상품의 도시와 달라서 L1
                      구조가 강제로 변경됨
                    </li>
                    <li>
                      LLM 이 5-Layer 규칙보다 사용자의 자유 텍스트/테마 변경
                      요구를 우선 반영함
                    </li>
                    <li>
                      기준 상품에 없던 박수/시즌 조건으로 호텔·일정이 재구성됨
                    </li>
                  </ul>
                </Alert>
              </Box>
            )}
          </Box>
        )}

        {/* 도시 비교 */}
        <Box>
          <Box variant="awsui-key-label">방문 도시</Box>
          <ColumnLayout columns={2}>
            <Box>
              <CityChips cities={refCities} />
            </Box>
            <Box>
              <CityChips
                cities={newCities}
                added={new Set(cityDiff.added)}
                kept={new Set(cityDiff.kept)}
              />
              {(cityDiff.added.length > 0 || cityDiff.removed.length > 0) && (
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  {cityDiff.added.map((c) => (
                    <span
                      key={`a-${c}`}
                      style={{ color: "#0972d3", marginRight: 8 }}
                    >
                      ➕ {c}
                    </span>
                  ))}
                  {cityDiff.removed.map((c) => (
                    <span
                      key={`r-${c}`}
                      style={{
                        color: "#d91515",
                        marginRight: 8,
                        textDecoration: "line-through",
                      }}
                    >
                      ➖ {c}
                    </span>
                  ))}
                </div>
              )}
            </Box>
          </ColumnLayout>
        </Box>

        {/* 호텔 비교 */}
        <Box>
          <Box variant="awsui-key-label">호텔</Box>
          <ColumnLayout columns={2}>
            <Box>
              <HotelList hotels={refHotels} />
            </Box>
            <Box>
              <HotelList hotels={result.hotels || []} />
            </Box>
          </ColumnLayout>
        </Box>

        {/* 일자별 관광지 비교 */}
        <Box>
          <Box variant="awsui-key-label">일자별 관광지</Box>
          <SpaceBetween size="xs">
            {allDays.map((day) => {
              const refList = refDayMap.get(day) || [];
              const newList = newDayMap.get(day) || [];
              const refSet = new Set(refList);
              const newSet = new Set(newList);
              return (
                <div
                  key={day}
                  style={{
                    border: "1px solid #e9ebed",
                    borderRadius: 6,
                    padding: 8,
                  }}
                >
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      marginBottom: 4,
                    }}
                  >
                    Day {day}
                  </div>
                  <ColumnLayout columns={2}>
                    <DayAttractions
                      list={refList}
                      otherSet={newSet}
                      mode="reference"
                    />
                    <DayAttractions
                      list={newList}
                      otherSet={refSet}
                      mode="generated"
                    />
                  </ColumnLayout>
                </div>
              );
            })}
          </SpaceBetween>
        </Box>
      </SpaceBetween>
    </Container>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function CityChips({
  cities,
  added,
  kept,
}: {
  cities: string[];
  added?: Set<string>;
  kept?: Set<string>;
}) {
  if (cities.length === 0) {
    return (
      <Box color="text-body-secondary" variant="small">
        (없음)
      </Box>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {cities.map((c) => {
        const isAdded = added?.has(c);
        const isKept = kept?.has(c);
        return (
          <span
            key={c}
            style={{
              padding: "2px 8px",
              borderRadius: 12,
              fontSize: 12,
              background: isAdded
                ? "#cfe2ff"
                : isKept
                  ? "#d1e7dd"
                  : "#f1f3f5",
              color: isAdded
                ? "#084298"
                : isKept
                  ? "#0f5132"
                  : "#495057",
              border: `1px solid ${
                isAdded ? "#9ec5fe" : isKept ? "#a3cfbb" : "#e0e0e0"
              }`,
            }}
          >
            {isAdded ? "+ " : ""}
            {c}
          </span>
        );
      })}
    </div>
  );
}

function HotelList({ hotels }: { hotels: string[] }) {
  if (hotels.length === 0)
    return (
      <Box color="text-body-secondary" variant="small">
        (정보 없음)
      </Box>
    );
  return (
    <SpaceBetween size="xxs">
      {hotels.map((h, i) => (
        <Box key={i} variant="small">
          • {h}
        </Box>
      ))}
    </SpaceBetween>
  );
}

function DayAttractions({
  list,
  otherSet,
  mode,
}: {
  list: string[];
  otherSet: Set<string>;
  mode: "reference" | "generated";
}) {
  if (list.length === 0) {
    return (
      <Box color="text-body-secondary" variant="small">
        (자유 일정)
      </Box>
    );
  }
  return (
    <div style={{ fontSize: 12, lineHeight: 1.7 }}>
      {list.map((name, i) => {
        const inBoth = otherSet.has(name);
        // mode=reference: 양쪽 다 있으면 회색(유지), 자기만 있으면 빨간 취소선(제거됨)
        // mode=generated: 양쪽 다 있으면 회색(유지), 자기만 있으면 파란색(추가됨)
        let style: React.CSSProperties;
        if (inBoth) {
          style = { color: "#687078" };
        } else if (mode === "reference") {
          style = { color: "#d91515", textDecoration: "line-through" };
        } else {
          style = { color: "#0972d3", fontWeight: 500 };
        }
        return (
          <div key={`${i}-${name}`} style={style}>
            {inBoth ? "✓" : mode === "reference" ? "➖" : "➕"} {name}
          </div>
        );
      })}
    </div>
  );
}

// Re-export for tree-shake
export type { DayItinerary };
