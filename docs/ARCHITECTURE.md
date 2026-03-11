# 여행상품 기획 AI Agent - 아키텍처 문서

---

## 1. 시스템 개요

여행사의 패키지 상품 MD가 새로운 여행 패키지 상품을 기획할 때, Knowledge Graph 기반의 AI Agent가 초안 일정을 자동 생성하는 시스템이다.

**핵심 특징:**
- **Knowledge Graph 단일 데이터 소스**: Neptune Graph DB에 패키지, 도시, 관광지, 호텔, 노선, 트렌드를 그래프로 저장
- **5-Layer 유사도 다이얼**: 기존 상품 대비 유사도를 0~100% 연속 조절하여 어떤 레이어를 유지/변경할지 제어
- **2-Phase 생성**: Sonnet(구조) → Opus(상세) 순차 생성으로 비용 최적화 + 품질 확보
- **듀얼 인터페이스**: 자연어 챗 모드 + 구조화 폼 모드
- **트렌드 반영**: 외부 소스(YouTube, Naver, Google Trends, 뉴스)에서 수집한 트렌드를 그래프에 적재하고 상품에 반영
- **프롬프트 최적화**: Phase별 컨텍스트 필터링 + Bedrock Prompt Caching으로 LLM 입력 토큰 76% 절감
- **트렌드 Tier 분류**: hot/steady/seasonal Tier 분류 및 배합 비율(trend_mix) 지원

---

## 2. 전체 아키텍처

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          브라우저 (MD 사용자)                               │
│    ┌──────────────┐   ┌──────────────┐   ┌──────────┐   ┌───────────────┐   │
│    │  챗 모드     │   │  폼 모드     │   │ 트렌드   │   │ 그래프 탐색   │   │
│    │ (자연어 입력)│   │ (드롭다운 등)│   │ 대시보드 │   │ (Cytoscape)   │   │
│    └──────┬───────┘   └──────┬───────┘   └────┬─────┘   └───────┬───────┘   │
│           └──────────┬───────┘                │               │             │
└──────────────────────┼────────────────────────┼───────────────┼─────────────┘
                       │ SSE                    │ SSE           │ REST
                       ▼                        ▼               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│   Tier 1: Next.js (Frontend + API Gateway)                                  │
│   Cloudscape Design System · React 19 · TypeScript                          │
│                                                                             │
│   ┌──────────────────────────────────────────────────────────────────┐      │
│   │ API Routes                                                       │      │
│   │                                                                  │      │
│   │ /api/planning ─── AgentCore Runtime 호출 (SigV4) → SSE 중계      │      │
│   │ /api/trends/collect ── Trend AgentCore 호출 (SigV4) → SSE 중계   │      │
│   │ /api/packages ─── Neptune Gremlin 직접 조회                      │      │
│   │ /api/graph/* ──── Neptune Gremlin 직접 조회 (시각화/필터)        │      │
│   │ /api/products ─── DynamoDB 직접 CRUD                             │      │
│   └──────┬───────────────┬─────────────────────────┬─────────────────┘      │
└──────────┼───────────────┼─────────────────────────┼────────────────────────┘
           │ SigV4         │ Gremlin WSS (SigV4)     │ AWS SDK
           ▼               ▼                         ▼
┌─────────────────┐  ┌──────────────┐         ┌──────────────┐
│ Tier 2:         │  │ Amazon       │         │ Amazon       │
│ AgentCore       │  │ Neptune      │         │ DynamoDB     │
│ Runtime         │  │ (Graph DB)   │         │              │
│                 │  │              │         │ ota-planned- │
│ ┌─────────────┐ │  │ Package,City │         │ products     │
│ │ OTA Travel  │ │  │ Attraction,  │         └──────────────┘
│ │ Agent       │ │  │ Hotel,Route, │
│ │ (Planning)  │ │  │ Theme,Trend, │
│ ├─────────────┤ │  │ TrendSpot    │
│ │ Trend       │ │  └──────────────┘
│ │ Collector   │ │           ▲
│ │ Agent       │ │           │ Gremlin WSS (SigV4)
│ └──────┬──────┘ │           │
└────────┼────────┘           │
         │ MCP (SigV4)        │
         ▼                    │
┌─────────────────────────────────────────────────────────────────┐
│ AgentCore Gateway (AWS_IAM 인증)                                │
│                                                                 │
│ ┌─────────────────────────┐  ┌───────────────────────────────┐  │
│ │ Target: travel-tools    │  │ Target: trend-collector       │  │
│ │ 17 tools                │  │ 4 tools                       │  │
│ │ (9 graph read +         │  │ (youtube, naver,              │  │
│ │  3 write + 4 DDB +      │  │  google_trends, news_crawl)   │  │
│ │  1 cache mgmt)          │  │                               │  │
│ └───────────┬─────────────┘  └─────────────┬─────────────────┘  │
└─────────────┼──────────────────────────────┼────────────────────┘
              │ Lambda Invoke                │ Lambda Invoke
              ▼                              ▼
┌──────────────────────┐       ┌──────────────────────────┐
│ Lambda:              │       │ Lambda:                  │
│ ota-travel-tools     │       │ ota-trend-collector      │
│ (VPC — Neptune 접근) │       │ (Public — 외부 API 접근) │
│                      │       │                          │
│ → Neptune Gremlin    │       │ → YouTube Data API v3    │
│ → DynamoDB           │       │ → Naver Open API         │
└──────────────────────┘       │ → Google Trends          │
                               │ → Google News RSS        │
                               └──────────────────────────┘
```

---

## 3. 컴포넌트 상세

### 3.1 AI Agent (Strands Agents Framework)

Agent는 **Strands Agents** 프레임워크 기반으로 구현되며, **AgentCore Runtime**에 배포된다.

#### 에이전트 목록 (5개)

| 에이전트 | 모델 | 용도 | 도구 사용 | 출력 |
|---------|------|------|----------|------|
| **Chat Parser** | Sonnet 4.6 | 자연어 → 구조화 입력 파싱 | 없음 | `PlanningInput` (Pydantic) |
| **Skeleton** | Sonnet 4.6 | Phase 1: 여행 구조 생성 (도시, 항공, 호텔, 가격) | 없음 (사전 수집된 컨텍스트 사용) | `SkeletonOutput` |
| **Day Detail** | Opus 4.6 | Phase 2: 일별 상세 생성 (관광지, 식사, 트렌드) | MCP Gateway 전체 | `DayDetailOutput` |
| **Conversational** | Sonnet 4.6 | 멀티턴 대화 + 기획 트리거 | MCP Gateway 전체 | 자유 텍스트 (한국어) |
| **Collector** | Sonnet 4.6 | 트렌드 수집 및 Neptune 저장 | MCP Gateway 전체 | JSON 요약 |

#### 배포 구성 (AgentCore Runtime)

| 에이전트 | ARN | 네트워크 | 이유 |
|---------|-----|---------|------|
| `ota_travel_agent` | `arn:aws:bedrock-agentcore:ap-northeast-2:...:runtime/ota_travel_agent-*` | VPC | Neptune/Valkey 접근 필요 |
| `ota_trend_collector` | 별도 ARN | PUBLIC | 외부 API만 호출 |

---

### 3.2 2-Phase 생성 파이프라인 (DAG)

핵심 아키텍처 혁신. Strands `GraphBuilder`로 구현된 6-노드 DAG:

```
┌──────────────┐     ┌───────────────────┐     ┌─────────────────────┐
│ ParseInput   │────▶│ CollectContext    │────▶│ GenerateSkeleton    │
│              │     │                   │     │ (Sonnet — Phase 1)  │
│ 입력 파싱 +  │     │ MCP 5개 도구 호출 │     │ 도시/항공/호텔/가격 │
│ 유사도 규칙  │     │ (Valkey 캐싱)     │     │ 관광지 미포함       │
└──────────────┘     └───────────────────┘     └─────────┬───────────┘
                                                        │
                                                        ▼
                                              ┌────────────────────┐
                                              │ ValidateSkeleton   │
                                              │ 프로그래밍 검증    │
                                              └────┬─────────┬─────┘
                                         FAIL(≤3회)│         │PASS
                                    ┌──────────────┘         │
                                    │ (correction_guide      │
                                    │  포함 재시도)          │
                                    ▼                        ▼
                              ┌─────────────┐    ┌──────────────────────────────────┐
                              │  재생성     │    │ GenerateDayDetails               │
                              │ (Skeleton)  │    │ (Opus — Phase 2)                 │
                              └─────────────┘    │ 일별 병렬 생성 (asyncio.gather)  │
                                                 │ 관광지 사전 배분 → 중복 방지     │
                                                 └─────────┬────────────────────────┘
                                                           │
                                                           ▼
                                                 ┌──────────────────┐
                                                 │ValidateDayDetails│
                                                 │ 전체 일정 검증   │
                                                 └────┬────────┬────┘
                                            FAIL(≤3회)│        │PASS
                                       ┌──────────────┘        │
                                       │ (실패 일자만           ▼
                                       │  부분 재생성)    ┌──────────┐
                                       ▼                  │  완료    │
                                 ┌──────────────┐         │ (merge + │
                                 │ 부분 재생성  │         │  save)   │
                                 │ (Day Detail) │         └──────────┘
                                 └──────────────┘
```

#### 왜 2-Phase인가?

| 항목 | 단일 패스 (Legacy) | 2-Phase (현행) |
|------|-------------------|---------------|
| **비용** | Opus 1회 (전체 생성) | Sonnet(구조) + Opus(상세) — 구조 생성에 저렴한 모델 |
| **품질** | 구조 + 상세 동시 생성 시 불일치 가능 | 구조 확정 후 상세 생성 — 일관성 보장 |
| **재시도** | 전체 재생성 | Phase 1/2 독립 재시도 + 실패 일자만 부분 재생성 |
| **중복 방지** | 관광지 중복 빈발 | 관광지 사전 배분(라운드 로빈) + 병렬 생성 + ValidateDayDetails에서 중복 검증 |
| **속도** | Opus 1회 (오래 걸림) | Sonnet(빠름) + Opus(일별 병렬) — 8일 기준 160초→25초 |

---

### 3.3 5-Layer 유사도 시스템

기존 상품 대비 새 상품의 변경 범위를 연속적으로 제어하는 핵심 개념:

```
유사도 100% ◄─────────────────────────────────────────► 유사도 0%
(복제)         거의 동일      테마 변경      신규 상품      (완전 신규)

Layer 5: Theme/Branding   (weight: 0.10)  ──── 항상 변경 가능
Layer 4: Activities        (weight: 0.30)  ──── 30% 이하에서 변경
Layer 3: Core Attractions  (weight: 0.50)  ──── 50% 이하에서 변경
Layer 2: Hotels            (weight: 0.70)  ──── 70% 이하에서 변경
Layer 1: Routes/Cities     (weight: 0.95)  ──── 5% 이하에서만 변경 (가장 견고)
```

**알고리즘** (`similarity/layer_rules.py`):
```
threshold = 1.0 - (similarity / 100)
각 레이어: weight > threshold → 유지(RETAIN), else → 변경(MODIFY)
```

**예시:**
- `similarity=80` → threshold=0.20 → L1~L4 유지, L5만 변경 (리브랜딩)
- `similarity=50` → threshold=0.50 → L1~L2 유지, L3~L5 변경 (테마 변경)
- `similarity=30` → threshold=0.70 → L1만 유지, L2~L5 변경 (같은 지역 신상품)

---

### 3.4 Valkey(Redis) 캐싱 전략

MCP 도구 호출 결과를 캐싱하여 반복 조회 비용을 절감:

#### TTL 전략 (exact-match 매핑)

| 도구명 | TTL | 카테고리 |
|---|---|---|
| `get_routes_by_region`, `get_attractions_by_city`, `get_hotels_by_city`, `get_nearby_cities`, `get_cities_by_country` | 24시간 | 정적 |
| `get_package`, `get_similar_packages` | 12시간 | 준정적 |
| `get_trends` | 6시간 | 동적 |
| `search_packages`, `get_product`, `list_products` | 1시간 | 가장 동적 |
| (빈 결과) | 5분 | Negative caching |

**캐시 키 형식**: `mcp:{tool_name}:{sha256(sorted_args)[:16]}`
**장애 대응**: fail-open (연결 실패 시 캐시 비활성화, 직접 호출 계속)

#### 쓰기 도구 제외

`WRITE_TOOLS` frozenset: `upsert_trend`, `upsert_trend_spot`, `link_trend_to_spot`, `save_product`, `delete_product` — `get()`/`set()`에서 조기 반환

#### 재연결 메커니즘 (Circuit Breaker)

- `_disabled: bool` → `_disabled_until: float` (monotonic timestamp) + `_consecutive_failures: int`
- 지수 백오프: 30초 → 60초 → 120초 → 300초(최대)
- ConnectionError/TimeoutError 시 클라이언트 리셋 → 다음 호출에서 자동 재연결
- 복구 성공 시 failures 카운터 리셋

#### Agent MCP 호출 캐시 (Strands Hooks)

- `ValkeyCacheHook(HookProvider)` — `agent/src/hooks/cache_hook.py`
- `BeforeToolCallEvent`: cache HIT → `selected_tool`을 `_CachedResultTool`로 교체 (MCP 호출 건너뜀)
- `AfterToolCallEvent`: cache MISS + success → `cache.set()`으로 결과 저장
- Day Detail, Itinerary, Conversational 3개 Agent에 `hooks=[ValkeyCacheHook()]` 등록
- Gateway prefix (`travel-tools___`) 스트리핑 → bare tool name으로 캐시 키 생성
- CollectContextNode의 `_safe_call()`과 동일 Valkey 키스페이스 공유

#### 캐시 무효화

- `ValkeyCache.delete_pattern(tool_name)`: SCAN 기반 `mcp:{tool_name}:*` 삭제
- `ValkeyCache.flush_tool_cache()`: `mcp:*` 전체 삭제
- Lambda `invalidate_cache` 도구: Gateway MCP를 통해 원격 무효화
- trend-agent 수집 완료 후 `invalidate_cache(tool_pattern="get_trends")` 자동 호출

#### Frontend Two-Tier Cache

Agent 측 Valkey 캐싱과 별도로, Next.js 프론트엔드에도 2계층 캐시 적용:

| 계층 | 구현 | 범위 | 용량/설정 |
|------|------|------|----------|
| **L1: In-memory** | `web/src/lib/api-cache.ts` | per-process | 200 entry cap, per-key TTL |
| **L2: Valkey** | `web/src/lib/valkey.ts` | 공유 (ElastiCache Serverless) | circuit-breaker (5s→60s backoff) |

**TTL 프리셋**:

| 프리셋 | TTL | 적용 대상 |
|--------|-----|----------|
| `GRAPH_STATIC` | 1시간 | 전체 그래프 시각화 (`/api/graph/visualize`) |
| `GRAPH_SEMI` | 30분 | 이웃 확장 (`visualize/neighbors`), 패키지 서브그래프 (`visualize/package`) |
| `STATIC` | 1시간 | 정적 Neptune API (cities, hotels, attractions, routes, regions) |
| `SEMI_STATIC` | 30분 | 준정적 Neptune API (packages) |
| `TRENDS` | 5분 | 트렌드 관련 API |

- **캐시 키 접두사**: `web:` (프론트엔드) vs `mcp:` (Agent 측) — 키스페이스 분리
- 그래프 시각화 라우트는 L1 + L2 양계층 적용, 나머지 9개 Neptune API 라우트는 L1 In-memory만 적용
- L2 Valkey 장애 시 fail-open (L1만으로 서비스 계속)

#### OpenTelemetry 메트릭

- `cache_hit_total`, `cache_miss_total` (Counter, tool_name attribute)
- `cache_error_total` (Counter, tool_name + operation)
- `cache_latency_seconds` (Histogram)
- `cache_entry_size_bytes` (Histogram)
- AgentCore Runtime에서 aws-opentelemetry-distro가 자동으로 CloudWatch export

---

### 3.5 검증 엔진 (Programmatic Validator)

LLM 호출 없이 프로그래밍 방식으로 일정을 검증하여 1-2초 내 결과 도출:

**점수 체계**: `100 - (ERROR * 15) - (WARNING * 5)` → 통과 기준: `≥ 70점`

| 검증 항목 | 심각도 | 설명 |
|----------|--------|------|
| 시간 예산 초과 | ERROR | `(관광지수 × 1.5h) + ((관광지수-1) × 0.5h) > 13h` |
| 교차일 관광지 중복 | ERROR | 다른 날에 같은 관광지 방문 |
| 이동시간 180분 초과 | ERROR | 도시간 이동 시간 과다 |
| 일자 수 불일치 | ERROR | `day_allocations.length ≠ duration` |
| 비행 시간 버퍼 부족 | WARNING | 출발/도착일 3시간 여유 미확보 |
| 호텔-다음날 도시 불일치 | WARNING | N일 마지막 도시 ≠ N+1일 첫 도시 |
| 관광지 수 불균형 | WARNING | 일간 관광지 수 편차 과다 |
| 원거리 도시 이동 | WARNING | 알려진 원거리 쌍 (도쿄-오사카 등) |

**재시도 시**: `correction_guide`(한국어 교정 지시문)를 생성하여 LLM에 전달 → 타겟 수정

---

### 3.6 프롬프트 아키텍처

총 5개의 시스템 프롬프트가 각 에이전트의 행동을 정의:

| 프롬프트 | 대상 에이전트 | 핵심 지시 |
|---------|-------------|----------|
| `chat_parser_system.py` | Chat Parser | 한국어 자연어 → `PlanningInput` 추출 규칙 (목적지, 기간, 시즌, 테마, 예산 등) |
| `skeleton_system.py` | Skeleton | Phase 1 규칙: 도시-일자 배분, 항공 선택, 호텔 배치, 가격 산출. "관광지 상세 생성 금지" 명시 |
| `day_detail_system.py` | Day Detail | Phase 2 규칙: 일별 관광지 선정, 시간 배분, 트렌드 삽입. 점수 기반 자체 검증 규칙 포함 |
| `conversational_system.py` | Conversational | 멀티턴 대화 규칙, 도구 사용 가이드, `<!--PLANNING_TRIGGER:JSON-->` 마커로 기획 파이프라인 자동 트리거 |
| `collector_system.py` | Trend Collector | 3단계 수집 프로세스, virality_score/decay_rate 산정 기준, evidence 필수 포함 규칙 |

---

### 3.7 프롬프트 최적화 전략

OTEL 텔레메트리 분석 결과, 전체 LLM 입력 토큰의 93%가 불필요한 graph_context 중복이었음.
Phase별 컨텍스트 필터링 + Bedrock Prompt Caching으로 토큰 비용 76% 절감.

#### Phase별 컨텍스트 필터링

| Phase | 에이전트 | 전달 컨텍스트 | 제외 항목 | 절감율 |
|-------|---------|-------------|----------|--------|
| **Phase 1** (Skeleton) | Sonnet | routes, city_hotels, reference_package(요약), similar_packages(요약), city_attraction_counts | trends 전체, attraction 상세, activities, themes | 85% |
| **Phase 2** (Day Detail) | Opus | 해당 일자 도시의 city_attractions/city_hotels/trends만 + reference_day_attractions | routes, similar_packages, 다른 도시 데이터 전체 | 88% |

**헬퍼 함수** (`orchestrator/nodes.py`):
- `_build_skeleton_context()`: Skeleton용 축약 (trends 제거, similar_packages에서 code/name/price/rating만)
- `_build_day_context(graph_context, day_cities, day_num)`: 해당 일자 도시 데이터만 추출
- `_summarize_reference()`: reference_package에서 attractions/activities/themes 제거
- `_summarize_similar()`: 패키지당 6개 필드만 유지 (code, name, price, nights, rating, region)
- `_filter_trends_by_cities()`: spot 위치 기반 도시 필터링 + evidence URL 제거
- `_count_attractions()`: 관광지 수만 `{"방콕": 17, "파타야": 7}` 형태로 축약

#### Bedrock Prompt Caching

모든 Agent에 `CacheConfig(strategy="auto")` 적용:
- 시스템 프롬프트 + 도구 정의에 자동 `cachePoint` 삽입
- Day Detail 병렬 실행 시 동일 prefix 캐시 재활용
- Opus 캐시 읽기: $1.5/MTok (정가 $15/MTok 대비 **90% 할인**)
- Sonnet 캐시 읽기: $0.30/MTok (정가 $3/MTok 대비 **90% 할인**)

#### 토큰 절감 실측 (OTEL 기반, 방콕 3박4일)

| 프롬프트 | 최적화 전 | 최적화 후 | 절감율 |
|---------|----------|----------|--------|
| Skeleton 사용자 | 35,827 chars | 6,947 chars | 81% |
| Day Detail (단일 도시) | ~35,700 chars | ~8,000 chars | 78% |
| Day Detail (복수 도시) | ~35,700 chars | ~15,000 chars | 58% |
| **총 User Prompt** | **142,959 chars** | **53,108 chars** | **63%** |

---

## 4. 데이터 모델

### 4.1 Neptune Knowledge Graph 스키마

#### 정점 (Vertex) 레이블

| 레이블 | 주요 속성 | 설명 |
|--------|----------|------|
| `Package` | code, price, nights, rating, season(JSON), hashtags(JSON), shopping_count, guide_fee(JSON) | 기존 여행 패키지 상품 |
| `City` | name, region | 도시 (region으로 지역 그룹핑) |
| `Attraction` | name, category | 관광지/명소 |
| `Hotel` | name, grade, has_onsen | 숙박 시설 |
| `Route` | (항공 노선 데이터) | 항공 노선 (출발-도착) |
| `Theme` | name | 여행 테마 (온천, 미식, 역사 등) |
| `Activity` | (활동 데이터) | 액티비티 |
| `Trend` | title, type, source, date, virality_score, decay_rate, tier, keywords(JSON), evidence(JSON) | 트렌드 정보 (tier: hot/steady/seasonal) |
| `TrendSpot` | name, description, category, lat, lng, photo_worthy | 트렌드 관련 장소 |

#### 간선 (Edge) 레이블

```
Package ──VISITS──▶ City          (day, order)
Package ──INCLUDES──▶ Attraction  (day, order, layer)
Package ──INCLUDES_HOTEL──▶ Hotel
Package ──DEPARTS_ON──▶ Route     (type: flight_type)
Package ──TAGGED──▶ Theme
Package ──HAS_ACTIVITY──▶ Activity (day)
Package ──SIMILAR_TO──▶ Package   (score: 0.0~1.0)

City ──HAS_ATTRACTION──▶ Attraction
City ──HAS_HOTEL──▶ Hotel
City ──NEAR──▶ City               (distance_km)

Route ──TO──▶ City

Trend ──FILMED_AT──▶ TrendSpot
Trend ──FEATURES──▶ TrendSpot
TrendSpot ──LOCATED_IN──▶ City
```

### 4.2 DynamoDB 테이블

**테이블명**: `ota-planned-products`
**PK**: `product_code` (String)
**코드 형식**: `AI-{flight_number}-{CUID}` (서버 측 생성, LLM 생성 코드 덮어씀)

### 4.3 Pydantic 데이터 모델

```
PlanningInput                        SkeletonOutput (Phase 1)
├── destination (필수)                ├── day_allocations[]
├── duration (nights/days, 필수)      │   └── day, cities[]
├── departure_season (필수)           ├── flights
├── similarity_level (0-100)          ├── hotels[]
├── reference_product_id              ├── pricing
├── themes[]                          └── inclusions/exclusions
├── trend_mix (Optional[dict])         {"hot": 70, "steady": 30}
├── target_customer
├── max_budget_per_person             DayDetailOutput (Phase 2)
├── max_shopping_count                ├── day_number
├── meal_preference                   ├── attractions[]
├── hotel_grade                       ├── attraction_details[]
└── input_mode (form/chat)            ├── highlights[]
                                      └── trend_spots_used[]

                    merge_skeleton_and_days()
                            │
                            ▼
                     PlanningOutput (최종)
                     ├── package_name, description
                     ├── flights, cities, pricing
                     ├── itinerary[] (일별 일정)
                     ├── attractions[] (관광지 사전)
                     ├── hotels[], shopping[]
                     ├── inclusions/exclusions
                     ├── insurance, meeting_info
                     ├── booking_policy
                     ├── similarity_score
                     ├── changes_summary
                     ├── trend_sources[]
                     └── generated_at, generated_by
```

---

## 5. 인프라 아키텍처

### 5.1 Lambda 함수

| Lambda | 리전 | 런타임 | 메모리 | 타임아웃 | 네트워크 | 역할 |
|--------|------|--------|--------|---------|---------|------|
| `ota-travel-tools` | ap-northeast-2 | Python 3.11 | 512MB | 30초 | VPC (Neptune 접근) | Graph 조회/쓰기 + DynamoDB CRUD |
| `ota-trend-collector` | ap-northeast-2 | Python 3.11 | 512MB | 60초 | Public | 외부 API 크롤링 (YouTube, Naver, Google, News) |

**라우팅 메커니즘**: Gateway가 `context.client_context.custom["bedrockAgentCoreToolName"]` 형식 `targetName___toolName`으로 도구명을 전달 → Lambda handler가 `___` 기준 분리 후 레지스트리에서 함수 매핑

### 5.2 AgentCore Gateway

| 항목 | 값 |
|------|---|
| **ID** | `REDACTED_GATEWAY_ID` |
| **인증** | `AWS_IAM` (SigV4 서명 필수) |
| **프로토콜** | MCP (Streamable HTTP) |
| **URL** | `https://ota-travel-gateway-*.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp` |

| Target | Lambda | 도구 수 | 설명 |
|--------|--------|--------|------|
| `travel-tools` | `ota-travel-tools` | 17 | 9 graph read + 3 graph write + 4 DynamoDB + 1 cache mgmt |
| `trend-collector` | `ota-trend-collector` | 4 | youtube, naver, google_trends, news_crawl |

### 5.3 MCP 도구 카탈로그 (21개)

#### Graph 읽기 도구 (9개)

| 도구 | 입력 | 출력 | 설명 |
|------|------|------|------|
| `get_package` | package_code | 패키지 + 연관 엔티티 전체 | 1-hop 그래프 순회 |
| `search_packages` | destination, theme, season, nights, max_budget, shopping_max | 패키지 목록 (최대 10) | 다조건 필터 검색, rating 정렬 |
| `get_routes_by_region` | region | 항공 노선 목록 | Route→TO→City 순회 |
| `get_attractions_by_city` | city, category? | 관광지 목록 | City→HAS_ATTRACTION |
| `get_hotels_by_city` | city, grade?, has_onsen? | 호텔 목록 | City→HAS_HOTEL |
| `get_trends` | region, min_score? | 트렌드 + 스팟 (시간 감쇠 점수, tier 포함) | 유효 점수 = virality × (1-decay)^months |
| `get_similar_packages` | package_code | 유사 패키지 목록 | SIMILAR_TO 간선 순회 |
| `get_nearby_cities` | city, max_km? | 인접 도시 목록 | NEAR 간선, 거리순 |
| `get_cities_by_country` | country | 도시 목록 | Country→HAS_CITY |

#### Graph 쓰기 도구 (3개)

| 도구 | 입력 | 설명 |
|------|------|------|
| `upsert_trend` | title, type, source, date, virality_score, decay_rate, tier?, keywords?, evidence? | 트렌드 Upsert (fold/coalesce, 멱등) |
| `upsert_trend_spot` | name, description?, category?, lat?, lng?, photo_worthy? | 트렌드 스팟 Upsert |
| `link_trend_to_spot` | trend_title, trend_source, spot_name, edge_label?, city_name? | 트렌드↔스팟↔도시 연결 |

#### DynamoDB 도구 (4개)

| 도구 | 설명 |
|------|------|
| `save_product` | AI 생성 상품 저장 (product_code 서버 생성: `AI-{flight}-{CUID}`) |
| `get_product` | product_code로 단건 조회 |
| `list_products` | 목록 조회 (limit, region 필터) |
| `delete_product` | 상품 삭제 |

#### 캐시 관리 도구 (1개)

| 도구 | 입력 | 출력 | 설명 |
|------|------|------|------|
| `invalidate_cache` | tool_pattern, flush_all? | 삭제된 키 수 | Valkey 캐시 패턴 삭제 (SCAN 기반) |

#### 트렌드 수집 도구 (4개)

| 도구 | 외부 API | 설명 |
|------|---------|------|
| `youtube_search` | YouTube Data API v3 | 지역 여행 영상 검색 (조회수순) |
| `naver_search` | Naver Blog + Cafe API | 한국어 블로그/카페 게시글 검색 |
| `google_trends` | Google Trends (pytrends) | 키워드별 관심도 추이 + 연관 검색어 |
| `news_crawl` | Naver News + Google News RSS | 최신 여행 뉴스 크롤링 |

---

## 6. 웹 프론트엔드

### 6.1 기술 스택

- **프레임워크**: Next.js (App Router) + React 19 + TypeScript 5.7
- **디자인 시스템**: AWS Cloudscape Design System v3
- **그래프 시각화**: Cytoscape (react-cytoscapejs) — 5가지 레이아웃 (cose, concentric, breadthfirst, circle, grid)
- **차트**: Recharts (트렌드 버블 차트)
- **상태 관리**: 커스텀 훅 (전역 상태 없음, 페이지별 독립)

### 6.2 페이지 구조

| 경로 | 컴포넌트 | 기능 |
|------|---------|------|
| `/planning` | `PlanningPage` | 상품 기획 (챗 모드 / 폼 모드 탭 전환) |
| `/products` | `ProductTable` | AI 생성 상품 목록 (DynamoDB, 10건/페이지 페이지네이션, YYYY-MM-DD HH:mm 날짜 형식) |
| `/products/[code]` | `ProductDetail` → `ResultPanel` | 상품 상세 조회 |
| `/packages` | `PackageTable` → `PackageDetail` | 기존 패키지 브라우징 (Neptune) |
| `/trends` | `TrendDashboard` | 트렌드 대시보드 (요약/버블차트/테이블/수집) |
| `/graph` | `GraphExplorer` | Knowledge Graph 시각적 탐색 |

### 6.3 주요 컴포넌트

```
PlanningPage
├── ChatMode            ← 자연어 대화 (스트리밍, 도구 사용 표시, 기획 트리거)
├── FormMode            ← 13개 입력 필드 (지역/기간/시즌/테마/유사도 등)
│   ├── SimilaritySlider ← 5-Layer 시각적 표시 + 0-100% 슬라이더
│   └── TrendMixSlider   ← 트렌드 배합 비율 (핫:스테디) 슬라이더
├── ProgressBar         ← 4단계 진행률 (파싱→컨텍스트→생성→검증)
└── ResultPanel         ← 8개 섹션 (요약/가격/항공/일정/관광지/호텔/포함사항/변경이력)
    └── ItineraryCard   ← 일별 일정 카드

TrendDashboard
├── TrendBubbleChart    ← Scatter: X=신선도, Y=바이럴점수, Z=유효점수(크기)
└── TrendTable          ← 페이지네이션 테이블 + 확장형 Evidence 패널

GraphExplorer
├── CytoscapeGraph    ← Cytoscape.js (5가지 레이아웃, 호버 하이라이트, 줌 엣지 라벨)
├── GraphFilterBar    ← 노드 타입 멀티셀렉트 필터
├── GraphLegend       ← 색상 범례
├── NodeDetailPanel   ← 선택 노드 속성 + 이웃 확장
└── PackageSubgraph   ← 패키지 서브그래프 (동심원/계층형 레이아웃)
```

### 6.4 데이터 흐름

#### 기획 흐름 (Form/Chat → SSE → 결과)

```
사용자 입력 (폼/채팅)
    │
    ▼ fetchSSE("/api/planning", body) — AbortSignal.timeout(600_000) (10분, 7박+ 장기 일정 대응)
Next.js API Route
    │
    ▼ invokeAgentCore(body) — SigV4 서명
AgentCore Runtime
    │
    ▼ SSE 이벤트 스트림
┌──────────────────────────────────────┐
│ progress  → ProgressBar 업데이트     │
│ message_chunk → 채팅 스트리밍 텍스트 │
│ tool_use  → 도구 사용 상태 표시      │
│ result    → ResultPanel 렌더링       │
│ error     → 에러 Alert 표시          │
└──────────────────────────────────────┘
```

#### 트렌드 수집 흐름

```
"트렌드 수집" 버튼 클릭 (region 선택)
    │
    ▼ POST /api/trends/collect
invokeTrendCollector() — SigV4 서명
    │
    ▼ Trend Agent (Sonnet)
┌──────────────────────────────────────┐
│ 1. 4개 수집 도구 호출 (YouTube 등)   │
│ 2. LLM 분석 → 트렌드/스팟 추출       │
│ 3. Neptune 저장 (upsert 3개 도구)    │
└──────────────────────────────────────┘
    │
    ▼ 수집 완료 → 트렌드 데이터 자동 새로고침
```

---

## 7. 인증 및 보안

### 7.1 인증 체계

| 구간 | 인증 방식 | 설명 |
|------|----------|------|
| 브라우저 → Next.js | (미구현) | 현재 인증 없음 |
| Next.js → AgentCore Runtime | AWS SigV4 | `@smithy/signature-v4`, `bedrock-agentcore` 서비스 |
| Agent → AgentCore Gateway | AWS SigV4 | httpx Auth 커스텀 (`GatewaySigV4Auth`), `bedrock-agentcore` 서비스 |
| Gateway → Lambda | IAM Role | Gateway IAM Role이 `lambda:InvokeFunction` 권한 보유 |
| Lambda → Neptune | AWS SigV4 | `neptune-db` 서비스 IAM 인증 |
| Next.js → Neptune | AWS SigV4 | `gremlin-aws-sigv4` + `@aws-sdk/credential-providers` |
| Next.js → DynamoDB | AWS SDK | 인스턴스 프로파일 / 환경 변수 자격 증명 |

### 7.2 IAM 역할

| 역할 | 권한 |
|------|------|
| `ota-travel-tools-lambda-role` | neptune-db:*, dynamodb CRUD, VPC 네트워크 |
| `Agent-core-Gateway` | lambda:InvokeFunction (ota-travel-tools, ota-trend-collector) |
| AgentCore Runtime 실행 역할 | bedrock:InvokeModel, bedrock-agentcore Gateway 호출 |

---

## 8. 파일 구조

```
travel-md/
├── Makefile                          # 빌드/배포 태스크 러너
├── .env.example                      # 환경 변수 템플릿
│
├── agent/                            # 메인 여행 기획 에이전트
│   ├── pyproject.toml                # Python 패키지 설정
│   ├── .bedrock_agentcore.yaml       # AgentCore 배포 설정 (VPC)
│   └── src/
│       ├── agentcore_app.py          # 프로덕션 진입점 (BedrockAgentCoreApp)
│       ├── local_server.py           # 로컬 개발 FastAPI 서버
│       ├── config.py                 # 환경 설정 상수
│       ├── mcp_connection.py         # SigV4 MCP 클라이언트 싱글턴
│       ├── cache.py                  # Valkey 캐싱 레이어
│       ├── hooks/                    # Strands Agent 캐시 훅
│       │   ├── __init__.py
│       │   └── cache_hook.py         #   ValkeyCacheHook (MCP 도구 투명 캐싱)
│       ├── agents/                   # Strands 에이전트 정의
│       │   ├── chat_parser.py        #   자연어 파서 (Sonnet)
│       │   ├── skeleton.py           #   Phase 1 구조 생성 (Sonnet)
│       │   ├── day_detail.py         #   Phase 2 상세 생성 (Opus)
│       │   ├── conversational.py     #   멀티턴 대화 (Sonnet)
│       │   └── itinerary.py          #   [Legacy] 단일 패스 생성
│       ├── orchestrator/
│       │   ├── graph.py              #   DAG 정의 (6노드 GraphBuilder)
│       │   └── nodes.py              #   노드 구현 (8개, 6개 활성)
│       ├── prompts/                  # 시스템 프롬프트 (한국어)
│       │   ├── chat_parser_system.py
│       │   ├── skeleton_system.py
│       │   ├── day_detail_system.py
│       │   ├── conversational_system.py
│       │   └── itinerary_system.py   #   [Legacy]
│       ├── models/                   # Pydantic 데이터 모델
│       │   ├── input.py              #   PlanningInput
│       │   ├── output.py             #   PlanningOutput, SkeletonOutput, DayDetailOutput
│       │   └── graph_types.py        #   Neptune 엔티티 TypedDict
│       ├── similarity/
│       │   └── layer_rules.py        #   5-Layer 유사도 계산
│       ├── validator/
│       │   └── itinerary_validator.py #  프로그래밍 검증 엔진
│       ├── tools/                    # [로컬 전용] Gremlin 도구 구현
│       │   ├── graph_client.py
│       │   ├── get_package.py
│       │   ├── search_packages.py
│       │   └── ... (8개 도구)
│       └── storage/
│           └── dynamodb.py           #   [로컬 전용] DynamoDB CRUD
│
├── trend-agent/                      # 트렌드 수집 에이전트
│   ├── .bedrock_agentcore.yaml       # AgentCore 배포 설정 (PUBLIC)
│   └── src/
│       ├── config.py
│       ├── mcp_connection.py         # SigV4 MCP 클라이언트
│       ├── agents/
│       │   └── collector.py          #   수집 에이전트 (Sonnet)
│       └── prompts/
│           └── collector_system.py   #   수집 프로세스 프롬프트
│
├── infra/
│   ├── agentcore/
│   │   └── .bedrock_agentcore.yaml   # 참조용 설정 템플릿
│   ├── lambda/                       # ota-travel-tools Lambda
│   │   ├── handler.py                #   라우팅 디스패처 (17 도구)
│   │   ├── graph_client.py           #   Neptune Gremlin 클라이언트
│   │   └── tools/
│   │       ├── graph_tools.py        #   12개 Graph 도구 + 1 캐시 관리
│   │       └── dynamodb_tools.py     #   4개 DynamoDB 도구 구현
│   ├── trend-collector-lambda/       # ota-trend-collector Lambda
│   │   ├── handler.py                #   라우팅 디스패처 (4 도구)
│   │   └── tools/
│   │       ├── youtube_search.py
│   │       ├── naver_search.py
│   │       ├── google_trends.py
│   │       └── news_crawl.py
│   └── scripts/
│       ├── deploy_lambda.sh          # travel-tools Lambda 배포
│       ├── setup_gateway.sh          # AgentCore Gateway 생성
│       ├── deploy_trend_collector.sh # trend-collector Lambda 배포
│       └── setup_trend_collector_target.sh # Gateway 트렌드 타겟 추가
│
└── web/                              # Next.js 프론트엔드
    ├── package.json
    ├── next.config.ts
    └── src/
        ├── app/
        │   ├── layout.tsx            # Cloudscape 루트 레이아웃
        │   ├── page.tsx              # / → /planning 리다이렉트
        │   ├── planning/page.tsx
        │   ├── products/page.tsx
        │   ├── products/[code]/page.tsx
        │   ├── packages/page.tsx
        │   ├── trends/page.tsx
        │   ├── graph/page.tsx
        │   └── api/                  # API 엔드포인트
        │       ├── planning/route.ts
        │       ├── products/route.ts
        │       ├── products/[code]/route.ts
        │       ├── packages/route.ts
        │       ├── packages/[code]/route.ts
        │       ├── trends/collect/route.ts
        │       └── graph/{cities,attractions,hotels,routes,regions,trends,visualize,visualize/neighbors,visualize/package}/
        ├── components/
        │   ├── layout/               # AppLayout, Navigation
        │   ├── planning/             # PlanningPage, FormMode, ChatMode, ResultPanel, ...
        │   ├── common/               # SimilaritySlider, ThemeMultiselect, TrendMixSlider
        │   ├── packages/             # PackageTable, PackageDetail
        │   ├── products/             # ProductTable, ProductDetail
        │   ├── trends/               # TrendDashboard, TrendBubbleChart, TrendTable
        │   └── graph/                # GraphExplorer, CytoscapeGraph, NodeDetailPanel, ...
        ├── hooks/                    # usePlanning, useChat, usePackages, useProducts, useTrends, useTrendCollector
        └── lib/                      # agentcore.ts, sse-client.ts, dynamodb.ts, gremlin.ts, api-cache.ts, valkey.ts, types.ts
```

---

## 9. 핵심 설계 결정 및 트레이드오프

| 결정 | 이유 | 트레이드오프 |
|------|------|-------------|
| **Neptune(Graph DB)을 단일 데이터 소스로** | 여행 상품의 구조적 관계(도시-관광지-호텔-노선)를 자연스럽게 표현. 벡터 유사도보다 정확한 관계 질의 | 집계/분석 쿼리에 약함. DynamoDB 별도 필요 |
| **AgentCore Gateway + Lambda 분리** | Agent 추론과 도구 실행 분리. Lambda 독립 배포/스케일링 가능 | MCP 중계 레이턴시 추가 (~50ms) |
| **2-Phase 생성 (Sonnet → Opus)** | 비용 최적화 + 구조 일관성 + 부분 재시도 | 전체 생성 시간 증가 (순차 실행) |
| **Valkey 캐싱 (fail-open)** | 반복 조회 절감, Neptune 부하 감소 | 캐시 미스 시 첫 요청 느림. 캐시 장애 시 직접 조회 |
| **SSE 전구간 스트리밍** | 30초+ 생성 시간 동안 실시간 진행률 표시 | 연결 유지 비용, keepalive 필요 (8초 하트비트) |
| **Gateway AWS_IAM 인증** | AWS 네이티브, 별도 토큰 관리 불필요 | AWS CLI가 이 인증 타입 미지원 → raw SigV4 API 호출 필요 |
| **일별 병렬 생성 (Day Detail)** | 관광지 사전 배분(라운드 로빈) + asyncio.gather로 병렬 실행 | 관광지 배분 정확도가 순차 방식보다 약간 낮을 수 있음 → ValidateDayDetails에서 검증 + 부분 재시도 |
| **Strands Hooks 기반 캐싱** | Agent 자율 MCP 호출(Day Detail, Conversational 등)에도 투명하게 캐시 적용 | Hook 오버헤드 미미 (~1ms), 캐시 형식 호환성 유지 필요 |
| **프로그래밍 검증 (LLM 미사용)** | 1-2초 검증 (LLM 검증은 10초+), 결정적 결과 | 맥락적 판단 불가 (e.g., "이 도시에서 3개 관광지가 적절한가") |
| **Next.js API Routes에서 Neptune 직접 조회** | 단순 조회(패키지 목록, 그래프 시각화)에 Agent 경유 불필요 | Gremlin 클라이언트 중복 (Lambda + Next.js 양쪽 구현) |
| **한국어 전용 프롬프트** | 대상 사용자(한국 OTA MD), 한국 여행 도메인 특화 | 다국어 확장 시 프롬프트 전면 재작성 필요 |
| **Phase별 컨텍스트 필터링** | Skeleton에는 구조 결정에 필요한 데이터만, Day Detail에는 해당 일자 도시 데이터만 전달 → 토큰 76% 절감 | 헬퍼 함수 유지보수 필요. graph_context 구조 변경 시 파서 업데이트 |
| **Bedrock Prompt Caching** | 시스템 프롬프트/도구 정의 자동 캐시 → Opus 입력 비용 90% 할인 | 캐시 TTL(5분) 내 재호출이 있어야 효과. 첫 호출은 캐시 쓰기 비용 25% 추가 |

---

## 10. 시퀀스 다이어그램

### 10.1 상품 기획 전체 흐름

```
MD(사용자)        Next.js          AgentCore        Agent(DAG)         Gateway         Lambda          Neptune
    │               │                │                │                │               │               │
    │ 폼 제출       │                │                │                │               │               │
    ├──────────────▶│                │                │                │               │               │
    │               │ SigV4 POST     │                │                │               │               │
    │               ├───────────────▶│                │                │               │               │
    │               │                │ invoke         │                │               │               │
    │               │                ├───────────────▶│                │               │               │
    │               │                │                │                │               │               │
    │               │                │                │ [ParseInput]   │               │               │
    │               │                │                │ 입력 파싱      │               │               │
    │               │  SSE:progress  │                │                │               │               │
    │◀──────────────┤◀───────────────┤◀───────────────┤                │               │               │
    │               │                │                │                │               │               │
    │               │                │                │[CollectContext]│               │               │
    │               │                │                │ MCP 도구 5회   │               │               │
    │               │                │                ├───────────────▶│  Invoke       │               │
    │               │                │                │                ├──────────────▶│ Gremlin       │
    │               │                │                │                │               ├──────────────▶│
    │               │                │                │                │               │◀──────────────┤
    │               │                │                │◀───────────────┤◀──────────────┤               │
    │               │  SSE:progress  │                │                │               │               │
    │◀──────────────┤◀───────────────┤◀───────────────┤                │               │               │
    │               │                │                │                │               │               │
    │               │                │                │ [GenerateSkeleton] Sonnet      │               │
    │               │                │                │ 도시/항공/호텔 구조 생성       │               │
    │               │                │                │                │               │               │
    │               │                │                │ [ValidateSkeleton]             │               │
    │               │                │                │ 프로그래밍 검증│               │               │
    │               │  SSE:progress  │                │                │               │               │
    │◀──────────────┤◀───────────────┤◀───────────────┤                │               │               │
    │               │                │                │                │               │               │
    │               │                │                │ [GenerateDayDetails] Opus (parallel)           │
    │               │                │                │ Day 1..N 병렬 생성 (asyncio.gather)            │
    │               │                │                │ 관광지 사전 배분 → 중복 방지                   │
    │               │                │                │                │               │               │
    │               │                │                │ [ValidateDayDetails]           │               │
    │               │                │                │ 전체 검증      │               │               │
    │               │                │                │                │               │               │
    │               │                │                │ merge + save   │               │               │
    │               │                │                ├───────────────▶│  save_product │               │
    │               │                │                │                ├──────────────▶│──▶ DynamoDB   │
    │               │                │                │◀───────────────┤◀──────────────┤               │
    │               │  SSE:result    │                │                │               │               │
    │◀──────────────┤◀───────────────┤◀───────────────┤                │               │               │
    │               │                │                │                │               │               │
    │ ResultPanel   │                │                │                │               │               │
    │ 렌더링        │                │                │                │               │               │
```

### 10.2 트렌드 수집 흐름

```
MD(사용자)        Next.js          AgentCore        Trend Agent       Gateway         Collector       Travel Lambda
    │               │                │                │                │               │               │
    │ 수집 요청     │                │                │                │               │               │
    ├──────────────▶│ SigV4 POST     │                │                │               │               │
    │               ├───────────────▶│ invoke         │                │               │               │
    │               │                ├───────────────▶│                │               │               │
    │               │                │                │                │               │               │
    │               │                │                │ youtube_search ├──────────────▶│               │
    │               │                │                │◀───────────────┤◀──────────────┤               │
    │               │                │                │ naver_search   ├──────────────▶│               │
    │               │                │                │◀───────────────┤◀──────────────┤               │
    │               │                │                │ google_trends  ├──────────────▶│               │
    │               │                │                │◀───────────────┤◀──────────────┤               │
    │               │                │                │ news_crawl     ├──────────────▶│               │
    │               │                │                │◀───────────────┤◀──────────────┤               │
    │               │                │                │                │               │               │
    │               │                │                │ LLM 분석 → 트렌드/스팟 추출    │               │
    │               │                │                │                │               │               │
    │               │                │                │ upsert_trend   ├──────────────────────────────▶│→Neptune
    │               │                │                │ upsert_spot    ├──────────────────────────────▶│→Neptune
    │               │                │                │ link_to_spot   ├──────────────────────────────▶│→Neptune
    │               │                │                │                │               │               │
    │               │                │                │ invalidate_cache ─────────────────────────────▶│→Valkey
    │               │                │                │                │               │               │
    │  SSE:result   │                │                │                │               │               │
    │◀──────────────┤◀───────────────┤◀───────────────┤                │               │               │
    │               │                │                │                │               │               │
    │ 대시보드      │ GET /api/graph/trends           │                │               │               │
    │ 자동 갱신     ├─────────────────────────────────────────────────────────────────────────────────▶│
    │◀──────────────┤◀─────────────────────────────────────────────────────────────────────────────────┤
```

---

## 11. 환경 설정

### 11.1 필수 환경 변수

```bash
# Neptune
GREMLIN_ENDPOINT=wss://travel.cluster-*.ap-northeast-2.neptune.amazonaws.com:8182/gremlin

# Valkey (ElastiCache)
REDIS_HOST=ota-valkey-*.serverless.apn2.cache.amazonaws.com
REDIS_PORT=6379

# Bedrock
BEDROCK_REGION=us-east-1              # 모델 호출 리전
AWS_REGION=ap-northeast-2             # 인프라 리전

# AgentCore Gateway
GATEWAY_MCP_URL=https://ota-travel-gateway-*.gateway.bedrock-agentcore.ap-northeast-2.amazonaws.com/mcp

# DynamoDB
DYNAMODB_TABLE_NAME=ota-planned-products

# 트렌드 수집 (Trend Collector Lambda 전용)
YOUTUBE_API_KEY=...
NAVER_CLIENT_ID=...
NAVER_CLIENT_SECRET=...
```

### 11.2 Makefile 타겟

```bash
make agent              # 로컬 에이전트 서버 실행
make frontend           # Next.js 개발 서버 실행
make deploy-lambda      # travel-tools Lambda 배포
make update-lambda      # travel-tools Lambda 업데이트
make setup-gateway      # AgentCore Gateway 생성
make deploy-all         # Lambda + Gateway 전체 배포
make create-table       # DynamoDB 테이블 생성
```

---

## 12. 알려진 제약사항

1. **AWS CLI 제약**: `bedrock-agentcore-control`이 `AWS_IAM` authorizer 타입 미지원 → Gateway 생성 시 raw SigV4 API 호출 필요
2. **Lambda 예약 환경변수**: `AWS_REGION`은 Lambda 예약 변수로 직접 설정 불가 → 자동으로 배포 리전 설정됨
3. **Neptune Gremlin 클라이언트 중복**: Lambda와 Next.js 양쪽에 Gremlin 클라이언트 구현 존재 (Lambda는 Python gremlinpython, Next.js는 JS gremlin)
4. **사용자 인증 미구현**: 브라우저 → Next.js 구간에 인증 없음 (내부 도구 가정)
5. **Trend Collector 외부 API 의존**: YouTube/Naver API 키 필요, Google Trends는 비공식 라이브러리(pytrends) 사용
6. **ElastiCache Serverless IaC 부재**: Valkey 인프라가 Terraform/CloudFormation으로 관리되지 않음
