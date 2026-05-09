# Lambda 도구 재설계 — Score-First Graph RAG

> **목표**: "그래프를 카탈로그처럼 dump하는" 옛 도구 셋을 버리고, **그래프 가중치 엣지를 점수 함수로 정식화하여 ranked + rationale 형태로 LLM에 전달**하는 도구 셋으로 전면 교체.
>
> **전제**: v3 SCHEMA_REFERENCE.md (간사이 4도시, 6,691 정점 / 30,108 엣지)

---

## 설계 원칙

| 원칙 | 의미 |
|---|---|
| **태스크 중심** | 도구 시그니처가 "어떤 데이터"가 아닌 "어떤 의사결정"을 표현 |
| **점수 함수 내장** | Cypher 안에 가중치 합산 점수가 박혀 있고 LLM은 ranked top-k만 받음 |
| **사유 노출** | rationale, score breakdown을 응답에 포함 → 결과 추적 가능 |
| **의도 캐시 키** | `(tool, all_params)`가 캐시 키. 사용자 의도가 다르면 다른 캐시 |
| **가중치는 LLM이 결정** | 도구가 α/β/γ를 받음. LLM이 자유 텍스트 보고 결정 |

---

## 도구 카탈로그 (총 10개)

### Phase 1 — Skeleton (Sonnet, 큰 그림)

#### 1. `get_reference_package(saleProdCd)`
기준 상품 풀 디테일. (옛 `get_package` 후속)

**입력**:
```yaml
saleProdCd: string  # 필수
```

**Cypher (총 6개 쿼리)**:
```cypher
MATCH (p:SaleProduct {saleProdCd: $code}) RETURN p
MATCH (p)-[:VISITS_CITY]->(c:City) RETURN c, source
MATCH (p)-[:ARRIVES_IN]->(c:City) RETURN c
MATCH (p)-[r:HAS_SCHEDULED_ATTRACTION]->(a:Attraction)
  RETURN a, r.schdDay, r.schtExprSqc ORDER BY schdDay, schtExprSqc
MATCH (p)-[hs:HAS_HOTEL_STAY]->(s:HotelStay)
  OPTIONAL MATCH (s)-[:MATCHED_TO]->(h:Hotel) RETURN s, h, hs.schdDay
MATCH (p)-[:HAS_FLIGHT_SEGMENT]->(f:FlightSegment)
  OPTIONAL MATCH (f)-[:DEPARTS_FROM_AIRPORT]->(da:Airport)
  OPTIONAL MATCH (f)-[:ARRIVES_AT_AIRPORT]->(aa:Airport)
  RETURN f, da, aa
MATCH (p)-[:HAS_BRAND]->(b:Brand) RETURN b
MATCH (p)-[:INSTANCE_OF]->(rp:RepresentativeProduct) RETURN rp
```

**응답**:
```jsonc
{
  "saleProduct": {...},
  "arrivalCity": {...},
  "visitCities": [{...}],
  "scheduledAttractions": [
    { "id": "Attraction:LJP_xxx", "name": "...", "schdDay": 1,
      "schtExprSqc": 1, "summary": "...", "type": "..." }
  ],
  "hotelStays": [{ "schdDay": 1, "hotel": {...}, "locaDesc": "..." }],
  "flightSegments": [{ "segReq": 1, "depAirport": {...}, "arrAirport": {...} }],
  "brand": {...},
  "representative": {...},
  "_trace": { "source": "live|cache", "queries": [...] }
}
```

**캐시**: 12h (semi-static)

---

#### 2. `find_similar_packages(saleProdCd?, theme_key?, season_quarter?, brand?, alpha=0.5, beta=0.3, gamma=0.2, limit=10)`
5-Layer 점수 기반 자매 SaleProduct 검색.

**입력**:
```yaml
saleProdCd: string?     # 기준 상품 (있으면 도시 set Jaccard 점수)
theme_key: string?      # v3 Theme.key
season_quarter: int?    # 1..4
brand: string?          # "세이브" | "스탠다드"
alpha: float = 0.5      # 도시 set Jaccard 가중
beta: float = 0.3       # 테마 가중
gamma: float = 0.2      # 시즌 가중
limit: int = 10
```

**점수 함수**:
```
ref_cities = {c | (ref)-[:VISITS_CITY|ARRIVES_IN]->(c)}
score(p) = α * jaccard(p_cities, ref_cities)
        + β * avg(IN_THEME[theme_key].weight on p's attractions)
        + γ * avg(BEST_IN_SEASON[Q].weight on p's attractions)
        + brand_match_bonus(0.05 if brand matches)
```

**Cypher (개념)**:
```cypher
MATCH (p:SaleProduct)
WHERE ($brand IS NULL OR p.brndNm = $brand)
  AND ($ref_code IS NULL OR p.saleProdCd <> $ref_code)
WITH p
// 도시 set Jaccard
OPTIONAL MATCH (p)-[:VISITS_CITY|ARRIVES_IN]->(pc:City)
WITH p, collect(DISTINCT pc.name) AS p_cities, $ref_cities AS ref_cities
WITH p,
     CASE WHEN size(ref_cities) = 0 THEN 0.0
          ELSE toFloat(size([c IN p_cities WHERE c IN ref_cities]))
               / toFloat(size(p_cities) + size(ref_cities)
                       - size([c IN p_cities WHERE c IN ref_cities]))
     END AS city_jaccard
// 테마 평균
OPTIONAL MATCH (p)-[:HAS_SCHEDULED_ATTRACTION]->(:Attraction)-[t:IN_THEME]->(:Theme {key: $theme_key})
WITH p, city_jaccard, avg(t.weight) AS theme_score
// 시즌 평균
OPTIONAL MATCH (p)-[:HAS_SCHEDULED_ATTRACTION]->(:Attraction)-[s:BEST_IN_SEASON]->(:Season {quarter: $q})
WITH p, city_jaccard, theme_score, avg(s.weight) AS season_score
WITH p,
     $alpha * coalesce(city_jaccard, 0)
   + $beta  * coalesce(theme_score, 0)
   + $gamma * coalesce(season_score, 0) AS score
WHERE score > 0
RETURN p, score
ORDER BY score DESC LIMIT $limit
```

**응답**:
```jsonc
{
  "weights": { "alpha": 0.5, "beta": 0.3, "gamma": 0.2 },
  "candidates": [
    { "saleProduct": {...}, "score": 0.78,
      "breakdown": { "city_jaccard": 1.0, "theme_score": 0.7, "season_score": 0.6 } }
  ],
  "_trace": {...}
}
```

**캐시**: 12h

---

#### 3. `recommend_route(arrival_city, nights, depart_city?)`
박수+도착 기준 항공 + 호텔 윤곽.

**입력**:
```yaml
arrival_city: string     # 필수
nights: int              # 필수
depart_city: string?     # 선택 (e.g. "ICN")
```

**Cypher**:
```cypher
// FlightSegment 기반 distinct 노선
MATCH (p:SaleProduct)-[:ARRIVES_IN]->(c:City)
WHERE c.name = $arr OR c.code = $arr
MATCH (p)-[:HAS_FLIGHT_SEGMENT]->(f:FlightSegment)
WHERE $dep IS NULL OR f.depAirportCode = $dep OR f.depCityName = $dep
RETURN DISTINCT
  f.depAirportCode AS depAirport, f.depAirportName AS depName,
  f.arrAirportCode AS arrAirport, f.arrAirportName AS arrName,
  f.airlCd AS airline, f.airlNm AS airlineName,
  count(*) AS frequency
ORDER BY frequency DESC

// 동일 박수 SaleProduct 의 호텔 stay 분포
MATCH (p:SaleProduct)-[:ARRIVES_IN]->(c:City)
WHERE (c.name = $arr OR c.code = $arr) AND p.trvlNgtCnt = $nights
MATCH (p)-[hs:HAS_HOTEL_STAY]->(s:HotelStay)
OPTIONAL MATCH (s)-[:MATCHED_TO]->(h:Hotel)
RETURN h.name AS hotel, h.grade AS grade,
       count(*) AS frequency,
       collect(DISTINCT hs.schdDay) AS used_on_days
ORDER BY frequency DESC LIMIT 20
```

**응답**:
```jsonc
{
  "arrival_city": "오사카",
  "nights": 3,
  "routes": [
    { "depAirport": "ICN", "arrAirport": "KIX", "airline": "TW",
      "airlineName": "티웨이", "frequency": 12 }
  ],
  "popular_hotels": [
    { "hotel": "...", "grade": "...", "frequency": 8, "used_on_days": [1,2,3] }
  ]
}
```

**캐시**: 12h

---

### Phase 2 — Day Detail (Opus, 세부)

#### 4. `recommend_attractions(...)` ⭐ 핵심
점수 함수 종합. **모든 신호 반영**.

**입력**:
```yaml
city: string                      # 필수
theme_key: string?                # v3 Theme.key
season_quarter: int?              # 1..4
exclude_ids: list[string]?        # 이미 선택된 명소 제외
selected_ids: list[string]?       # TRAVEL_TO 근접성 점수용 기준 명소들
mood_keywords: list[string]?      # 자유 텍스트 keyword (e.g. ["야경","로맨틱"])
arrival_airport_code: string?     # ARRIVAL_FIRST_VISIT 가점 (도착일에만)
alpha: float = 0.40               # IN_THEME 가중
beta:  float = 0.25               # BEST_IN_SEASON 가중
gamma: float = 0.15               # mood_keywords 매칭
delta: float = 0.15               # TRAVEL_TO 근접성
epsilon: float = 0.05             # ARRIVAL_FIRST_VISIT
limit: int = 15
min_score: float = 0.05
```

**점수 함수**:
```
score(a) = α * IN_THEME[a, Theme[theme_key]].weight
         + β * BEST_IN_SEASON[a, Season[Q]].weight
         + γ * |mood_keywords ∩ (featureMoodTagsJson + featureExperienceTagsJson)| / |mood_keywords|
         + δ * max(TRAVEL_TO[s, a].weight for s in selected_ids)
         + ε * ARRIVAL_FIRST_VISIT[Airport[arrival_airport_code], a].weight
```

**Cypher**:
```cypher
MATCH (a:Attraction)-[:IN_CITY]->(c:City)
WHERE (c.name = $city OR c.code = $city)
  AND ($exclude_ids IS NULL OR NOT a.id IN $exclude_ids)
OPTIONAL MATCH (a)-[t:IN_THEME]->(:Theme {key: $theme_key})
OPTIONAL MATCH (a)-[s:BEST_IN_SEASON]->(:Season {quarter: $q})
OPTIONAL MATCH (a)<-[afv:ARRIVAL_FIRST_VISIT]-(:Airport {airportCode: $arr_apt})
// TRAVEL_TO from selected — selected_ids 가 있으면 가장 높은 weight
OPTIONAL MATCH (sel:Attraction)-[tt:TRAVEL_TO]->(a)
  WHERE sel.id IN $selected_ids
WITH a,
     coalesce(t.weight, 0)  AS theme_w,
     coalesce(t.rationale, '') AS theme_reason,
     coalesce(s.weight, 0)  AS season_w,
     coalesce(afv.weight, 0) AS afv_w,
     coalesce(max(tt.weight), 0) AS travel_to_w
// mood overlap (애플리케이션 레벨 계산이 더 쉬움 — 응답으로 raw 데이터 반환)
WITH a, theme_reason, theme_w, season_w, afv_w, travel_to_w,
     a.featureMoodTagsJson AS mood_json,
     a.featureExperienceTagsJson AS exp_json,
     $alpha * theme_w
   + $beta  * season_w
   + $epsilon * afv_w
   + $delta * travel_to_w AS partial_score
WHERE partial_score >= $min_score OR theme_w > 0 OR season_w > 0
RETURN a.id AS id,
       a.name AS name,
       a.featureSummaryKo AS summary,
       a.recommendedStayMinutes AS stay_minutes,
       a.type AS type,
       a.nightViewFlag AS night_view,
       a.rainPlanRequired AS rain_sensitive,
       theme_w, season_w, afv_w, travel_to_w,
       mood_json, exp_json,
       partial_score, theme_reason
ORDER BY partial_score DESC LIMIT $limit_pre
```

`limit_pre = limit * 3` 으로 후보를 충분히 받고, **애플리케이션에서 mood overlap 점수 합산 후 final ranked top-`limit` 산출**. 이 분리는 Cypher에서 JSON 파싱이 까다로워서 채택.

**응답**:
```jsonc
{
  "city": "오사카",
  "theme_key": "FAMILY_WITH_KIDS",
  "season_quarter": 2,
  "weights": { "alpha": 0.4, "beta": 0.25, "gamma": 0.15, "delta": 0.15, "epsilon": 0.05 },
  "attractions": [
    {
      "id": "Attraction:LJP_8923",
      "name": "유니버설 스튜디오 재팬",
      "summary": "테마파크 — 가족 단위 인기 1위",
      "stay_minutes": 480,
      "type": "테마파크",
      "score": 0.91,
      "breakdown": {
        "theme": 0.95, "season": 0.85, "mood": 0.6,
        "travel_to": 0.0, "afv": 0.0
      },
      "rationale": "가족여행 테마 1순위 (해리포터·미니언즈 가족 단위 인기)",
      "flags": { "night_view": false, "rain_sensitive": false },
      "tags": { "mood": ["EXCITING","LIVELY"], "experience": ["RIDING"] }
    }
  ],
  "_trace": {...}
}
```

**캐시 키**: 모든 입력 파라미터 (mood_keywords sorted)
**캐시**: 6h

---

#### 5. `recommend_hotels(city, grade?, near_attraction_id?, limit=10)`
호텔 ranked. 명소 좌표 근처 우선.

**입력**:
```yaml
city: string
grade: string?
near_attraction_id: string?    # 거리 점수 기준
alpha: float = 0.7             # 도시 매칭 (binary)
beta: float = 0.3              # 거리 (Haversine, 가까울수록 점수 ↑)
limit: int = 10
```

**Cypher**:
```cypher
MATCH (h:Hotel)-[:IN_CITY]->(c:City)
WHERE c.name = $city OR c.code = $city
  AND ($grade IS NULL OR h.grade = $grade)
RETURN h.id AS id, h.name AS name, h.grade AS grade,
       h.lat AS lat, h.lng AS lng, h.address AS address,
       h.location AS location, h.thumbnail AS thumbnail
LIMIT 200
```

거리 가산점은 애플리케이션에서: 명소 좌표 기준 Haversine → 0~1 정규화.

**응답**:
```jsonc
{
  "city": "오사카",
  "near_attraction_id": "Attraction:LJP_8923",
  "hotels": [
    {
      "id": "Hotel:xxx", "name": "...", "grade": "5성급",
      "score": 0.94,
      "breakdown": { "city_match": 1.0, "distance_km": 0.6, "distance_score": 0.92 },
      "thumbnail": "..."
    }
  ]
}
```

**캐시**: 12h

---

#### 6. `get_attraction_neighbors(attraction_id, theme_key?, limit=10)`
TRAVEL_TO 엣지로 "다음에 자주 가는 명소".

**Cypher**:
```cypher
MATCH (a:Attraction {id: $aid})-[t:TRAVEL_TO]->(next:Attraction)
WHERE t.count >= 1
OPTIONAL MATCH (next)-[th:IN_THEME]->(:Theme {key: $theme_key})
RETURN next.id AS id, next.name AS name,
       t.count AS count, t.weight AS travel_weight,
       t.avgGapMinutes AS avg_gap,
       coalesce(th.weight, 0) AS theme_match
ORDER BY (t.weight * 0.7 + coalesce(th.weight, 0) * 0.3) DESC
LIMIT $limit
```

**응답**:
```jsonc
{
  "from_attraction": "Attraction:LJP_xxx",
  "neighbors": [
    { "id": "...", "name": "...", "count": 8, "travel_weight": 0.85,
      "avg_gap_minutes": 35, "theme_match": 0.75, "score": 0.82 }
  ]
}
```

**캐시**: 24h (정적)

---

#### 7. `get_attraction_detail(attraction_id)`
단건 명소 상세 (featureSummaryKo, 모든 enrichment).

**Cypher**:
```cypher
MATCH (a:Attraction {id: $aid})
OPTIONAL MATCH (a)-[:IN_CITY]->(c:City)
RETURN a, c.name AS cityName, c.code AS cityCode
```

**응답**: Attraction 노드 평탄화 + 도시 정보. `_trace` 포함.

**캐시**: 24h

---

### 메타 도구

#### 8. `explain_score(attraction_id, theme_key, season_quarter)`
점수 분해 (시연 + 디버깅용).

**응답**:
```jsonc
{
  "attraction_id": "...", "name": "...",
  "components": {
    "theme": { "weight": 0.95, "rationale": "..." },
    "season": { "weight": 0.85, "quarter": 2 },
    "mood_tags": ["EXCITING","LIVELY"],
    "feature_summary": "...",
    "stay_minutes": 480
  }
}
```

---

#### 9. `plan_context_bundle(saleProdCd?, theme_key?, season_quarter?, brand?, arrival_city, nights, dep_city?)`
**Skeleton 단계용 통합 호출** — MCP 콜드 스타트 35초 문제 완화.

**내부적으로** 다음을 1회 응답에 묶음:
- `get_reference_package(saleProdCd)` (있을 때만)
- `find_similar_packages(saleProdCd, theme_key, season_quarter, brand)`
- `recommend_route(arrival_city, nights, dep_city)`

**응답**:
```jsonc
{
  "reference": {...},          // get_reference_package 결과
  "similar": {...},            // find_similar_packages 결과
  "route": {...},              // recommend_route 결과
  "_trace": { ... }            // 모든 cypher 누적
}
```

**캐시**: 6h

---

#### 10. `invalidate_cache(tool_pattern?, flush_all?)`
Valkey 캐시 무효화. 시연 직전 또는 데이터 갱신 시.

(기존 도구 그대로 유지)

---

## DynamoDB 도구 (별개 카테고리, 그대로)

| 도구 | 목적 |
|---|---|
| `save_product` | AI 기획 결과 저장 |
| `get_product` | 단건 조회 |
| `list_products` | 목록 |
| `delete_product` | 삭제 |

→ 그래프 도구가 아니라 그대로 유지.

---

## 옛 도구 (제거)

| 옛 도구 | 대체 |
|---|---|
| `get_package` | `get_reference_package` |
| `search_packages` | `find_similar_packages` |
| `get_routes_by_region` | `recommend_route` |
| `get_attractions_by_city` | `recommend_attractions` |
| `get_hotels_by_city` | `recommend_hotels` |
| `get_similar_packages` | `find_similar_packages` |
| `get_nearby_cities` | (제거 — 4도시 한정) |
| `get_cities_by_country` | (Lambda에서 제거. UI 직접 라우트는 유지) |

---

## Phase별 도구 사용 매핑

```
ParseInputNode
  └ (도구 호출 없음)

CollectContextNode
  └ plan_context_bundle(saleProdCd, theme_key, season_quarter, brand, arrival_city, nights)
       → reference + similar + route 한 번에

GenerateSkeletonNode (Sonnet)
  └ (CollectContext 결과 + reference_data 가 prompt 에 박혀있음, 추가 호출 불필요)

GenerateDayDetailsNode (Opus, per day 병렬)
  └ recommend_attractions(city, theme_key, season_quarter,
                          exclude_ids=다른_day_명소,
                          selected_ids=같은_day_이미선택,
                          mood_keywords=LLM_decided,
                          arrival_airport_code=출발일만,
                          α/β/γ/δ/ε=LLM_decided)
  └ recommend_hotels(city, grade, near_attraction_id) — 필요 시
  └ get_attraction_neighbors(...) — 동선 최적화 시
  └ get_attraction_detail(...) — short_description 채울 때
```

---

## 캐시 전략 정리

| 도구 | TTL | 비고 |
|---|---|---|
| get_reference_package | 12h | semi-static |
| find_similar_packages | 12h | 가중치까지 키에 포함 |
| recommend_route | 12h | (arrival, nights, dep) 키 |
| recommend_attractions | 6h | 모든 파라미터 키 (mood_keywords sorted) |
| recommend_hotels | 12h | (city, grade, near_attraction_id) |
| get_attraction_neighbors | 24h | (aid, theme_key) |
| get_attraction_detail | 24h | (aid) |
| plan_context_bundle | 6h | 모든 파라미터 |
| explain_score | 24h | static |

`mcp:{tool}:{md5(canonical_json(args))[:12]}` — 모든 도구 동일 패턴.

---

## 성능 고려사항

### 2분 목표 분석
- Skeleton: Sonnet 1회 (~10초) + plan_context_bundle 1회 (~5~30초 cold)
- DayDetail: Opus N회 병렬 (~20~30초 per day, 4 days 병렬 = ~30초)
- 후처리/merge: < 1초
- **총합**: ~40~70초 (캐시 hit 우세) 또는 ~70~100초 (cold)

### 콜드 스타트 35초 분석
- MCP 클라이언트 첫 핸드셰이크 + SigV4 키 캐싱 (~20초 추정)
- Neptune boto3 첫 호출 (Lambda 콜드) (~5~10초)
- Valkey 첫 연결 (~1~2초)
- 합 ~30~35초 — `plan_context_bundle` 1회 호출로 흡수

### Cache hit rate 개선
- 동일 인자 재호출 → 즉시 hit (현재 동작과 동일)
- **새로운 인자 조합 = 새로운 cache miss** ← 의도대로 동작 (이전엔 도시 단위로 hit이라 의도 무시)

---

## 점수 가중치 LLM 결정 가이드

(프롬프트 단에 명시할 내용)

```
사용자 자유 텍스트를 보고 recommend_attractions 의 가중치를 결정하세요:

기본값: α=0.40 β=0.25 γ=0.15 δ=0.15 ε=0.05

조정 신호:
- "테마 충실하게 / 가족 콘셉트로" → α ↑ (0.55)
- "봄 벚꽃 / 가을 단풍 등 시즌" → β ↑ (0.40)
- "야경 / 로맨틱 / 조용한" 등 분위기 → γ ↑ (0.30) + mood_keywords 채우기
- "동선 짧게 / 도보 위주" → δ ↑ (0.30)
- "도착 첫날 / 공항 근처부터" → ε ↑ (0.20, 도착일에만)

mood_keywords 매핑 (자유 텍스트 → featureMoodTagsJson 값):
  "야경" → "NIGHT_VIEW"
  "조용" → "QUIET", "PEACEFUL"
  "활기" → "LIVELY"
  "로맨틱" → "ROMANTIC"
  "이국적" → "EXOTIC"
  ...
```

---

## 응답 일관성

모든 도구 응답에 `_trace` 메타 포함:
```jsonc
{
  ...,
  "_trace": {
    "source": "live | cache",
    "queries": [
      { "cypher": "...", "params": {...}, "rows": N, "latency_ms": N }
    ]
  }
}
```

이미 graph_client.py에 구현됨 → 새 도구 셋도 동일 패턴.

---

## 다음 작업

1. [Task #25] Lambda graph_tools.py 전면 재작성 (이 문서대로)
2. [Task #26] handler/Gateway schema 갱신
3. [Task #27] Agent tools 미러
4. [Task #28] orchestrator 호출 패턴 변경
5. [Task #29] 프롬프트 갱신
6. [Task #30] 배포
7. [Task #31] Web/UI 영향 점검
