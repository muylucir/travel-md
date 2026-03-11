# 왜 Conventional RAG가 아닌 GraphRAG인가

> OTA 여행상품 기획 AI Agent에 Graph 기반 RAG가 필수적인 이유

---

## 1. 핵심 주장

여행 상품 기획은 **구조적 관계 질의**가 본질이다. "오사카 3박4일, 온천 있는 호텔, 기존 상품과 70% 유사하게" 같은 요청은 텍스트 유사도가 아니라 **엔티티 간 관계 순회**로만 정확하게 해결된다. Conventional RAG(벡터 검색)는 이 구조를 평탄화(flatten)하여 관계 정보를 소실하므로, 여행 도메인에서는 GraphRAG가 유일한 선택이다.

---

## 2. Conventional RAG의 한계

### 2.1 여행 상품의 본질은 "관계의 집합"

하나의 여행 패키지는 다음 관계들의 복합체이다:

```
Package ──VISITS──▶ City (어느 도시를, 며칠차에)
Package ──INCLUDES──▶ Attraction (어떤 관광지를, 어떤 레이어에)
Package ──INCLUDES_HOTEL──▶ Hotel (어느 호텔에)
Package ──DEPARTS_ON──▶ Route (어떤 항공편으로)
Package ──TAGGED──▶ Theme (어떤 테마로)
City ──HAS_ATTRACTION──▶ Attraction (도시에 어떤 관광지가)
City ──HAS_HOTEL──▶ Hotel (도시에 어떤 호텔이)
City ──NEAR──▶ City (도시 간 거리)
```

Conventional RAG는 이 구조를 텍스트 청크로 분해한다:
```
"오사카 패키지 AAP001: 3박4일, 도톤보리, 금각사, 호텔 닛코..."
```

이렇게 평탄화하면 **"도톤보리가 오사카에 있고, 오사카 옆에 교토가 있고, 교토에 금각사가 있다"는 구조적 사실이 소실**된다.

### 2.2 벡터 유사도 ≠ 상품 유사도

두 여행 상품의 유사도는 텍스트가 비슷한 것이 아니라, **동일한 도시를 방문하고, 비슷한 노선을 사용하고, 유사한 등급의 호텔을 배정하는 것**이다.

| 비교 방식 | "오사카 미식여행 3박" vs "오사카 온천여행 3박" | "오사카 미식여행 3박" vs "도쿄 미식여행 3박" |
|----------|----------------------------------------------|----------------------------------------------|
| **벡터 유사도** | 낮음 (테마 다름) | 높음 (테마 동일) |
| **구조적 유사도** | 높음 (같은 도시, 같은 노선, 비슷한 호텔) | 낮음 (다른 도시, 다른 노선, 다른 호텔) |

여행 기획자 입장에서 진짜 유사한 상품은 **같은 도시/노선**을 공유하는 상품이다. 벡터 유사도는 이를 판별할 수 없다.

---

## 3. GraphRAG가 해결하는 7가지 핵심 문제

### 3.1 Multi-hop 관계 질의

**요구**: "간사이 지역에서 출발하는 항공편이 있는 도시들의 온천 호텔 목록"

**Graph 쿼리** (실제 코드, `get_hotels_by_city`):
```python
g.V().hasLabel("City").has("name", city)
 .out("HAS_HOTEL").hasLabel("Hotel")
 .has("has_onsen", True)
 .valueMap(True).toList()
```

**Conventional RAG**: "간사이 온천 호텔"로 벡터 검색 → 관련 없는 문서(간사이 관광 가이드, 온천 후기 등)가 상위에 올라옴. Route→City→Hotel 경로를 추론할 수 없음.

### 3.2 구조 기반 유사 상품 탐색 (SIMILAR_TO)

**요구**: "AAP001 패키지와 유사한 상품 찾기"

**Graph 쿼리** (실제 코드, `get_similar_packages`):
```python
g.V().hasLabel("Package").has("code", package_code)
 .outE("SIMILAR_TO")
 .project("package", "score")
 .by(__.inV().valueMap(True))
 .by(__.values("score"))
 .order().by(__.select("score"), Order.desc)
```

SIMILAR_TO 간선은 **도시 겹침, 노선 공유, 가격대, 일수** 등 구조적 속성을 기반으로 사전 계산된 유사도 점수(0.0~1.0)를 가진다. 이는 텍스트 임베딩으로 재현 불가능한 도메인 특화 유사도이다.

### 3.3 5-Layer 유사도 제어 시스템

이 프로젝트의 핵심 혁신인 **5-Layer 다이얼**은 그래프 구조 위에서만 동작한다:

```
Layer 1: Route/City   (weight=0.95) → get_routes_by_region, get_nearby_cities
Layer 2: Hotel        (weight=0.70) → get_hotels_by_city
Layer 3: Attraction   (weight=0.50) → get_attractions_by_city
Layer 4: Activity     (weight=0.30) → get_trends
Layer 5: Theme        (weight=0.10) → search_packages
```

`similarity=70`이면 Layer 1~2는 기존 상품에서 **유지(RETAIN)**, Layer 3~5는 **변경(MODIFY)**. 이 결정은 각 레이어에 매핑된 **그래프 도구**를 통해 실행된다. 벡터 검색으로는 "도시는 유지하되 관광지만 바꿔라"는 세밀한 제어가 불가능하다.

**트렌드 tier 배합 비율 (trend_mix)**: Layer 4(Activity/Trend)에 삽입되는 트렌드는 tier별 배합 비율로 제어된다.
- 기본값: hot 70% : steady 30%
- 폼 슬라이더 또는 대화 파싱으로 조정 가능 ("핫한 것만" → hot 90 : steady 10, "검증된 위주" → hot 30 : steady 70)
- `_distribute_trends_by_tier()`가 tier별 비율에 따라 트렌드를 비례 배분한다

이 기능은 그래프에 저장된 tier 속성(§3.4)을 기반으로 동작하며, 벡터 검색에서는 "핫한 트렌드 70%, 안정 트렌드 30%로 배합"이라는 구조적 제어가 불가능하다.

### 3.4 시간 감쇠 기반 트렌드 점수 + Tier 분류

**요구**: "현재 유효한 트렌드를 바이럴 점수 기반으로 정렬"

**Graph 쿼리** (실제 코드, `get_trends`):
```python
effective_score = virality_score × (1 - decay_rate) ^ months_elapsed
```

트렌드의 유효 점수는 **그래프 속성(virality_score, decay_rate, date)을 기반으로 실시간 계산**된다. Trend→FILMED_AT→TrendSpot→LOCATED_IN→City 경로를 순회하여 특정 지역의 유효 트렌드만 필터링한다.

Trend 노드는 `decay_rate` 기반으로 **tier** 필드를 갖는다:

| tier | decay_rate 범위 | 의미 | 예시 |
|------|----------------|------|------|
| **hot** | ≤ 0.10 | 상시 인기 — 바이럴/현재 진행형 | 맛집, 온천 |
| **steady** | 0.10 < d ≤ 0.25 | 중기 지속 — 검증된 안정 콘텐츠 | 벚꽃, 드라마 촬영지 |
| **seasonal** | > 0.25 | 단기 이벤트 — 시한부 콘텐츠 | 축제 |

`get_trends`는 `effective_score`와 함께 `tier`를 반환한다. 그래프에 `tier` 속성이 없는 기존 노드는 `_infer_tier(decay_rate)` 폴백으로 하위 호환을 보장한다. `upsert_trend`도 `tier` 파라미터를 받아 저장한다.

이 tier 분류는 상품 기획 시 **트렌드 배합(trend mixing)**을 가능하게 한다. 예를 들어 "핫한 요소 위주로 구성해줘"라는 요청에 hot 트렌드를 우선 배정하고, "검증된 콘텐츠 위주"라면 steady 트렌드를 중심으로 배치할 수 있다.

Conventional RAG에서는:
- 시간 감쇠 함수를 벡터 유사도에 적용할 수 없음
- TrendSpot의 지리적 위치(City 연결)를 벡터에 인코딩할 수 없음
- "방콕 지역 트렌드 중 유효 점수 30 이상"이라는 복합 필터링 불가
- decay_rate 기반 tier 분류 및 tier별 배합 비율 적용 불가

### 3.5 1-hop 서브그래프로 완전한 상품 재구성

**요구**: "기존 패키지 AAP001의 전체 구성 요소 조회"

**Graph 쿼리** (실제 코드, `get_package`):
```python
# 1-hop 순회로 7가지 연관 엔티티를 한 번에 수집
Package → VISITS → City[]          (일별 방문 도시)
Package → INCLUDES → Attraction[]  (일별/레이어별 관광지)
Package → INCLUDES_HOTEL → Hotel[] (숙박 시설)
Package → DEPARTS_ON → Route[]     (항공편)
Package → TAGGED → Theme[]         (테마)
Package → HAS_ACTIVITY → Activity[](액티비티)
Package → SIMILAR_TO → Package[]   (유사 상품)
```

**단 1회의 그래프 쿼리**로 패키지의 전체 구성을 가져온다. Conventional RAG에서는 7번의 별도 검색이 필요하고, 결과 간 관계(몇 일차에 어떤 도시의 어떤 관광지를 방문하는지)를 재구성할 수 없다.

### 3.6 지리적 근접성 기반 동선 최적화

**요구**: "오사카에서 100km 이내 도시 목록"

**Graph 쿼리** (실제 코드, `get_nearby_cities`):
```python
g.V().hasLabel("City").has("name", city)
 .outE("NEAR").has("distance_km", P.lte(max_km))
 .project("city", "distance_km")
 .by(__.inV().valueMap(True))
 .by(__.values("distance_km"))
 .order().by(__.select("distance_km"), Order.asc)
```

NEAR 간선에 `distance_km` 속성이 있어 **정확한 거리 기반 필터링**이 가능하다. 이 정보는 일정 구성 시 이동 동선의 합리성을 판단하는 데 필수적이다.

벡터 검색에서 "오사카 근처 도시"를 검색하면 텍스트에 "오사카 근처"라고 언급된 문서가 반환될 뿐, 실제 km 단위 거리 정보를 제공하지 못한다.

### 3.7 다조건 복합 필터 검색

**요구**: "방콕 지역, 여름 시즌, 미식 테마, 3박, 예산 150만원 이하, 쇼핑 2회 이하"

**Graph 쿼리** (실제 코드, `search_packages`):
```python
g.V().hasLabel("Package")
 .where(__.out("VISITS").hasLabel("City")
         .or_(__.has("name", "방콕"), __.has("region", "방콕")))
 .where(__.out("TAGGED").has("name", "미식"))
 .has("season", TextP.containing("여름"))
 .has("nights", 3)
 .has("price", P.lte(1500000))
 .has("shopping_count", P.lte(2))
 .order().by("rating", Order.desc)
```

6개 조건이 **그래프 속성 + 간선 순회**로 결합된다. 특히 `destination`(City vertex)과 `theme`(Theme vertex)은 간선으로 연결된 별도 엔티티이므로, 그래프 순회 없이는 단일 쿼리로 표현할 수 없다.

---

## 4. Conventional RAG를 적용한다면?

### 4.1 문서 설계의 딜레마

**방법 A: 패키지 단위 문서**
```json
{"text": "오사카 3박4일 미식여행. 1일차: 도톤보리, 2일차: 금각사..."}
```
→ 도시별 관광지 조회, 호텔 필터링, 노선 검색이 모두 불가능. 패키지 텍스트 전체를 반환해야 함.

**방법 B: 엔티티 단위 문서**
```json
{"text": "도톤보리: 오사카의 대표 관광지, 카테고리: 쇼핑/미식"}
```
→ "도톤보리가 포함된 패키지" 역검색 불가. 엔티티 간 관계 소실.

**방법 C: 관계 단위 문서**
```json
{"text": "패키지 AAP001이 2일차에 도톤보리를 방문함"}
```
→ 문서 수 폭발 (패키지 × 일수 × 관광지). 검색 시 관련 관계들을 모아 재구성하는 후처리 필요.

어떤 방법을 선택해도 **그래프가 자연스럽게 표현하는 구조를 평탄화하는 비용**을 치러야 한다.

### 4.2 쿼리 복잡도 비교

| 질의 | GraphRAG | Conventional RAG |
|------|----------|-----------------|
| "오사카에 있는 온천 호텔" | 1회 쿼리: `City→HAS_HOTEL→Hotel[has_onsen]` | 벡터 검색 "오사카 온천 호텔" → 후보 필터링 → 정확도 낮음 |
| "AAP001과 유사한 상품" | 1회 쿼리: `Package→SIMILAR_TO→Package` | 패키지 임베딩 비교 → 구조적 유사도 반영 못함 |
| "간사이 출발 4박 패키지의 모든 구성요소" | 1회 쿼리: 1-hop 서브그래프 | 7회 검색(도시, 관광지, 호텔, 노선, 테마, 액티비티, 유사상품) + 결과 조합 |
| "유사도 70%로 기존 상품 변형" | 5-Layer 규칙 → 레이어별 그래프 도구 호출 | **구현 불가** — 벡터 공간에서 레이어별 유지/변경 분리 없음 |
| "방콕 트렌드 중 유효점수 30+" | 1회 쿼리: `Trend→FILMED_AT→TrendSpot→LOCATED_IN→City[방콕]` + 시간 감쇠 계산 | 벡터 검색 + 후처리 시간 감쇠 + 지역 필터 = 복잡한 파이프라인 |

---

## 5. 이 프로젝트에서 GraphRAG의 실현

### 5.1 아키텍처

```
Agent (LLM) ──MCP──▶ Gateway ──▶ Lambda ──Gremlin──▶ Neptune (Graph DB)
                                                         │
                                                    9개 읽기 도구
                                                    (get_package,
                                                     search_packages,
                                                     get_routes_by_region,
                                                     get_attractions_by_city,
                                                     get_hotels_by_city,
                                                     get_trends → tier 포함 반환,
                                                     get_similar_packages,
                                                     get_nearby_cities,
                                                     get_cities_by_country)
                                                    + upsert_trend (tier 파라미터)
```

LLM이 **그래프 쿼리 도구**를 선택적으로 호출하여 필요한 관계 데이터를 수집한다. 이는 "검색 후 생성"이 아니라 **"구조적 탐색 후 생성"**이다.

### 5.2 Graph 데이터가 LLM 생성을 그라운딩하는 방식

```
CollectContextNode (Phase 0)
├── get_routes_by_region("간사이")     → 실제 항공편만 사용 (환각 방지)
├── get_attractions_by_city("오사카")  → 실제 관광지만 배정 (존재하지 않는 관광지 제거)
├── get_hotels_by_city("오사카")       → 실제 호텔만 배정
├── get_trends("간사이", min_score=30) → 유효 트렌드만 삽입
└── get_similar_packages("AAP001")     → 가격/구성 참고 (일관성)

Skeleton Agent (Phase 1 — Sonnet)
└── 위 데이터로 도시/항공/호텔 구조 결정 (관광지 미포함)

Day Detail Agent (Phase 2 — Opus, 병렬)
└── 일자별 도시의 관광지/트렌드만 필터링 + 트렌드 tier 배합 비율 적용하여 상세 생성
```

**그래프 데이터가 LLM의 "허용 범위"를 정의**한다:
- 존재하지 않는 항공편을 만들 수 없음 (routes에 있는 것만)
- Neptune에 없는 관광지를 배정할 수 없음 (city_attractions에 있는 것만)
- 실제 트렌드만 반영 (virality_score + 시간 감쇠를 통과한 것만)

---

## 6. 결론

| 관점 | Conventional RAG | GraphRAG (이 프로젝트) |
|------|-----------------|----------------------|
| **데이터 표현** | 텍스트 청크 + 벡터 | 엔티티 + 관계 (그래프) |
| **검색 방식** | 코사인 유사도 | Gremlin 순회 (정확한 관계 질의) |
| **구조 보존** | 평탄화로 소실 | 간선으로 자연 표현 |
| **다조건 필터** | 후처리 필수 | 쿼리 내 조합 |
| **유사도 정의** | 텍스트 유사도 | 구조적 유사도 (SIMILAR_TO 간선) |
| **레이어별 제어** | 불가능 | 5-Layer 다이얼로 정밀 제어 |
| **시간 감쇠** | 별도 파이프라인 | 그래프 속성 기반 실시간 계산 |
| **그라운딩** | Top-K 문서 참조 | 그래프 엔티티 직접 참조 (환각 최소화) |

**여행 상품 기획에서 Conventional RAG는 "비슷한 텍스트를 찾는 것"이고, GraphRAG는 "정확한 구조를 조립하는 것"이다.** 이 프로젝트가 만드는 것은 텍스트가 아니라 **도시-노선-호텔-관광지-트렌드의 구조적 조합**이므로, GraphRAG가 유일한 선택이다.
