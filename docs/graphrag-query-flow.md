# GraphRAG 쿼리 아키텍처

OTA Travel Agent가 Neptune GraphRAG를 쿼리하는 전체 흐름을 설명합니다.

---

## 1. 아키텍처 개요

에이전트는 Neptune에 직접 연결하지 않습니다. 모든 그래프 쿼리는 3-tier 구조를 거칩니다.

```
Agent (AgentCore Runtime)
  │  Strands SDK 기반 오케스트레이터
  │
  ▼  SigV4 서명된 HTTP (MCP 프로토콜)
AgentCore Gateway (MCP)
  │  AWS_IAM 인증, 도구 라우팅
  │
  ▼  Lambda Invoke
Lambda (VPC)
  │  Gremlin 쿼리 실행
  │
  ▼  WebSocket (SigV4)
Neptune (GraphDB)
```

**핵심 원칙**: 에이전트는 추론(reasoning)만 담당하고, 모든 데이터 접근은 MCP Gateway를 통해 이루어집니다.

---

## 2. 그래프 스키마

### 2.1 정점(Vertex) 라벨

| 라벨 | 설명 | 주요 속성 |
|------|------|-----------|
| Package | 여행 상품 | code, name, price, nights, rating, season, shopping_count |
| City | 도시 | name, region, country |
| Attraction | 관광지 | name, category, city |
| Hotel | 호텔 | name, grade, has_onsen |
| Route | 항공 노선 | departure, arrival |
| Airline | 항공사 | name |
| Theme | 테마 | name |
| Trend | 트렌드 | title, source, virality_score, decay_rate |
| TrendSpot | 트렌드 장소 | name |
| Country | 국가 | name |
| Region | 지역 | name |

### 2.2 간선(Edge) 관계

```
Package ──VISITS──▶ City          (day, order)
Package ──INCLUDES──▶ Attraction  (day, order, layer)
Package ──INCLUDES_HOTEL──▶ Hotel (layer, weight)
Package ──DEPARTS_ON──▶ Route     (type: outbound/return)
Package ──TAGGED──▶ Theme         (layer, weight)
Package ──HAS_ACTIVITY──▶ Activity(day)
Package ──SIMILAR_TO──▶ Package   (score: Jaccard ≥ 0.3)
City ──HAS_ATTRACTION──▶ Attraction
City ──HAS_HOTEL──▶ Hotel
City ──NEAR──▶ City               (distance_km, same_region)
Trend ──FILMED_AT/FEATURES──▶ TrendSpot
TrendSpot ──LOCATED_IN──▶ City
```

---

## 3. MCP 연결 계층

### 3.1 SigV4 인증 (`agent/src/mcp_connection.py`)

Gateway는 `AWS_IAM` 인증을 사용하므로 모든 HTTP 요청에 SigV4 서명이 필요합니다.

```python
class GatewaySigV4Auth(httpx.Auth):
    """bedrock-agentcore 서비스에 대한 SigV4 서명"""
    # botocore.auth.SigV4Auth로 Authorization, X-Amz-Date 헤더 추가
```

### 3.2 MCP 클라이언트 싱글턴

```python
def get_mcp_client() -> MCPClient:
    """Lazy 싱글턴 — 프로세스 수명 동안 유지"""
    # strands.tools.mcp.MCPClient + streamablehttp_client 전송
```

### 3.3 도구 이름 프리픽스

Gateway는 도구 이름을 `{target}___{tool}` 형식으로 관리합니다.

```python
def prefixed(tool_name: str) -> str:
    return f"travel-tools___{tool_name}"

# 호출 예시
mcp.call_tool_sync(prefixed("search_packages"), {"destination": "osaka"})
```

Gateway는 프리픽스에서 대상 Lambda를 식별하고, `context.client_context.custom["bedrockAgentCoreToolName"]`으로 전체 도구 이름을 전달합니다. Lambda handler는 이 값에서 `___` 뒤의 실제 도구 이름을 추출합니다.

---

## 4. 그래프 도구 (Graph Tools)

### 4.1 읽기 도구 (9개)

#### `search_packages` — 상품 검색
조건별 점진적 필터 체인으로 최대 10개 상품을 반환합니다.

```gremlin
g.V().hasLabel("Package")
  .where(__.out("VISITS").hasLabel("City")
    .or_(__.has("name", destination), __.has("region", destination)))
  [.where(__.out("TAGGED").has("name", theme))]      // 선택
  [.has("season", TextP.containing(season))]          // 선택
  [.has("nights", nights)]                            // 선택
  [.has("price", P.lte(max_budget))]                  // 선택
  [.has("shopping_count", P.lte(shopping_max))]       // 선택
  .order().by("rating", Order.desc)
  .limit(10)
  .valueMap(True)
```

#### `get_package` — 단일 상품 상세 조회
6개 개별 traversal로 완전한 상품 뷰를 구성합니다.

| 순서 | 쿼리 대상 | Edge 패턴 |
|------|-----------|-----------|
| 1 | 상품 기본 정보 | `g.V().hasLabel("Package").has("code", ...).valueMap(True)` |
| 2 | 방문 도시 | `outE("VISITS")` → day, order 속성 포함 |
| 3 | 관광지 | `outE("INCLUDES")` → layer 속성 포함 |
| 4 | 호텔 | `out("INCLUDES_HOTEL").valueMap(True)` |
| 5 | 항공편 | `outE("DEPARTS_ON")` → outbound/return 구분 |
| 6 | 테마 | `out("TAGGED").valueMap(True)` |

#### `get_routes_by_region` — 지역별 항공 노선
```gremlin
g.V().hasLabel("Route")
  .where(__.out("TO").hasLabel("City").has("region", region))
  .valueMap(True)
```

#### `get_attractions_by_city` — 도시별 관광지
```gremlin
g.V().hasLabel("City").has("name", city)
  .out("HAS_ATTRACTION").hasLabel("Attraction")
  [.has("category", category)]  // 선택적 카테고리 필터
  .valueMap(True)
```

#### `get_hotels_by_city` — 도시별 호텔
```gremlin
g.V().hasLabel("City").has("name", city)
  .out("HAS_HOTEL").hasLabel("Hotel")
  [.has("grade", grade)]        // 선택적 등급 필터
  [.has("has_onsen", true)]     // 선택적 온천 필터
  .valueMap(True)
```

#### `get_trends` — 트렌드 조회 (시간 감쇠 적용)
2-hop traversal로 지역에 연결된 트렌드를 조회하고, 시간 감쇠를 적용합니다.

```gremlin
g.V().hasLabel("Trend")
  .has("virality_score", P.gte(min_score))
  .where(__.out("FILMED_AT","FEATURES")
    .out("LOCATED_IN").hasLabel("City").has("region", region))
  .project("trend","spots")
  .by(__.valueMap(True))
  .by(__.out("FILMED_AT","FEATURES")
    .where(__.out("LOCATED_IN").hasLabel("City").has("region", region))
    .valueMap(True).fold())
```

후처리:
```
effective_score = virality_score * (1 - decay_rate) ^ months_elapsed
```
- `decay_rate ≤ 0.10` → hot tier
- `decay_rate ≤ 0.25` → steady tier
- `decay_rate > 0.25` → seasonal tier

#### `get_similar_packages` — 유사 상품 조회
```gremlin
g.V().hasLabel("Package").has("code", package_code)
  .outE("SIMILAR_TO")
  .project("package","score")
  .by(__.inV().valueMap(True))
  .by(__.values("score"))
  .order().by(__.select("score"), Order.desc)
  .limit(10)
```

#### `get_nearby_cities` — 인근 도시 조회
```gremlin
g.V().hasLabel("City").has("name", city)
  .outE("NEAR").has("distance_km", P.lte(max_km))
  .project("city","distance_km")
  ...
  .order().by(__.select("distance_km"), Order.asc)
```

#### `get_cities_by_country` — 국가별 도시 목록
```gremlin
g.V().hasLabel("City").has("country", country)
  .valueMap("name","region")
```

### 4.2 쓰기 도구 (3개)

| 도구 | 패턴 | 용도 |
|------|------|------|
| `upsert_trend` | fold/coalesce upsert | 트렌드 정점 생성/업데이트 |
| `upsert_trend_spot` | fold/coalesce upsert | 트렌드 장소 정점 생성/업데이트 |
| `link_trend_to_spot` | 존재 확인 후 간선 생성 | Trend→TrendSpot 연결 |

---

## 5. 오케스트레이터 쿼리 흐름

Planning DAG(`orchestrator/graph.py`)에서 GraphRAG 쿼리가 실행되는 순서입니다.

```
ParseInputNode
  │  입력 파싱 + 5-Layer 유사도 규칙 계산
  ▼
CollectContextNode          ◀── 핵심 쿼리 노드
  │  1. get_package()           (기준 상품이 있으면)
  │  2. search_packages()       (조건 기반 검색)
  │  3. get_routes_by_region()  (항공 노선)
  │  4. get_trends()            (트렌드)
  │  5. get_similar_packages()  (유사 상품, 기준 있으면)
  │  6. [지역 해석 폴백]        (도시명→지역 변환)
  │  7. get_attractions_by_city() × N개 도시
  │  8. get_hotels_by_city()     × N개 도시
  ▼
GenerateSkeletonNode
  │  Sonnet으로 일정 골격 생성 (MCP 호출 없음, 수집된 컨텍스트만 사용)
  ▼
ValidateSkeletonNode
  │  프로그래밍 방식 검증 (일수, 도시 전환, 항공편)
  │  ├── FAIL → GenerateSkeletonNode 재시도 (최대 3회)
  │  └── PASS ▼
GenerateDayDetailsNode
  │  Opus로 일별 상세 생성 (병렬)
  │  각 일별 에이전트가 추가 MCP 호출 가능
  ▼
ValidateDayDetailsNode
  │  시간 예산, 중복 관광지, 도시 연속성 검증
  │  ├── FAIL → 실패한 날만 재생성 (최대 3회)
  │  └── PASS → PlanningOutput 완성
```

### 5.1 CollectContextNode 상세

`_collect_context_via_mcp()` 메서드가 순차적으로 MCP 호출을 실행합니다.

**지역 해석 폴백**: 사용자가 도시명(예: "osaka")을 입력한 경우, `get_routes_by_region`이 빈 결과를 반환할 수 있습니다. 이때 `get_nearby_cities(city, max_km=0)`을 호출해 해당 도시의 지역을 파악한 후, 노선과 트렌드를 다시 조회합니다.

**도시별 선행 조회**: 검색 결과와 기준 상품에서 도시명을 추출하여 최대 5개 도시에 대해 관광지와 호텔을 미리 조회합니다 (출발 도시 "인천" 등은 제외).

모든 호출은 `_safe_call()`을 통해 실행되며, 개별 도구 실패 시 경고 로그만 남기고 부분 컨텍스트로 계속 진행합니다 (fail-open).

### 5.2 GenerateDayDetailsNode의 추가 쿼리

각 일별 에이전트(Opus)는 MCP 도구를 보유하고 있어 필요 시 추가 그래프 쿼리를 실행할 수 있습니다. 이 호출은 `ValkeyCacheHook`으로 캐싱됩니다.

---

## 6. 3중 캐싱 계층

동일한 Valkey(ElastiCache Serverless) 인스턴스를 공유하지만, 독립적인 키 공간을 사용하는 3개의 캐시 경로가 있습니다.

```
                        ┌─────────────────────┐
                        │     Valkey Cache     │
                        └──┬──────┬──────┬─────┘
                           │      │      │
           Path A          │  Path B     │  Path C
     CollectContextNode    │  CacheHook  │  Lambda 내부
      (agent/src/cache.py) │  (hooks/)   │  (graph_tools.py)
                           │             │
  키: mcp:{tool}:{sha256}  │  동일       │  키: mcp:{tool}:{md5}
```

### 6.1 Path A — CollectContextNode 직접 캐시

`agent/src/cache.py`의 `ValkeyCache` 클래스가 `_safe_call()`에서 사용됩니다.

**TTL 정책**:
| 분류 | TTL | 대상 도구 |
|------|-----|-----------|
| Static | 24h | routes, attractions, hotels, nearby_cities, cities_by_country |
| Semi-static | 12h | packages, similar |
| Dynamic | 6h | trends |
| Volatile | 1h | search, products |
| Negative | 5min | 빈 결과 |

**키 형식**: `mcp:{tool_name}:{sha256(args_json)[:16]}`

### 6.2 Path B — Strands Hook 캐시

`agent/src/hooks/cache_hook.py`의 `ValkeyCacheHook`이 에이전트 도구 호출 전후에 동작합니다.

- **Before Tool**: 캐시 HIT 시 `_CachedResultTool`로 대체하여 네트워크 호출 건너뜀
- **After Tool**: 캐시 MISS 후 성공 결과를 저장

GenerateDayDetailsNode의 일별 에이전트가 이 경로를 사용합니다.

### 6.3 Path C — Lambda 내부 캐시

`infra/lambda/tools/graph_tools.py`에서 각 읽기 도구가 `_cache_get`/`_cache_set`으로 캐싱합니다.

**키 형식**: `mcp:{tool_name}:{md5(args)[:12]}` — Path A/B와 해시 알고리즘이 다릅니다.

### 6.4 쓰기 도구 제외

`WRITE_TOOLS` frozenset에 포함된 도구(`upsert_*`, `save_*`, `delete_*`)는 모든 캐시 경로에서 제외됩니다.

### 6.5 캐시 무효화

`invalidate_cache` 도구로 패턴 기반 삭제(`mcp:{tool_pattern}:*`) 또는 전체 플러시(`mcp:*`)가 가능합니다. 트렌드 수집 에이전트가 수집 완료 후 호출합니다.

---

## 7. Neptune 연결 관리

### 7.1 Lambda 측 (`infra/lambda/graph_client.py`)

- 모듈 레벨 연결 — warm Lambda 호출 간 재사용
- `get_connection()`: `_is_connection_alive()` 확인 후 기존 연결 반환 또는 새로 생성
- `_get_neptune_headers()`: `neptune-db` 서비스에 대한 SigV4 서명으로 WebSocket 핸드셰이크
- `reset_connection()`: handler에서 transport/connection/websocket 에러 감지 시 호출

### 7.2 에이전트 측 (`agent/src/tools/graph_client.py`)

- `threading.local()` 기반 스레드별 연결 격리 (로컬 개발 서버용)
- 동일한 SigV4 인증과 `map_to_dict`/`parse_json_field` 헬퍼

### 7.3 Gremlin 결과 변환

`map_to_dict(element)`:
- `valueMap(True)` 결과의 단일 요소 리스트를 언래핑
- `T.id`, `T.label` 등의 `T.` 접두사 제거
- `parse_json_field()`로 JSON 인코딩된 문자열(season 배열, hashtags 등) 파싱

---

## 8. 에러 처리 및 복원력

| 계층 | 전략 |
|------|------|
| Neptune 연결 | `_is_connection_alive()` 사전 확인, `reset_connection()` 자동 재연결 |
| MCP 호출 | `_safe_call()` — 도구별 실패 시 부분 컨텍스트로 계속 (fail-open) |
| Valkey 캐시 | 서킷 브레이커 — 지수 백오프 (30s~300s), 모든 에러에서 fail-open |
| DAG 재시도 | Skeleton 최대 3회, Day Details 실패한 날만 최대 3회 |
| DAG 안전 장치 | `max_node_executions=20`, `execution_timeout=600s` |

---

## 9. 5-Layer 유사도 시스템

사용자가 기준 상품 대비 유사도(0-100)를 지정하면, 어떤 그래프 도구를 사용할지가 결정됩니다.

```
threshold = 1.0 - (similarity / 100)
```

| Layer | 대상 | Weight | 관련 도구 |
|-------|------|--------|-----------|
| 1 | 노선 (Route) | 0.95 | `get_routes_by_region`, `get_nearby_cities` |
| 2 | 호텔 (Hotel) | 0.70 | `get_hotels_by_city` |
| 3 | 관광지 (Attraction) | 0.50 | `get_attractions_by_city` |
| 4 | 액티비티 (Activity) | 0.30 | `get_trends`, `get_attractions_by_city` |
| 5 | 테마 (Theme) | 0.10 | `get_trends`, `search_packages` |

- `weight > threshold` → 해당 Layer 유지 (기준 상품과 동일하게)
- `weight ≤ threshold` → 해당 Layer 자유롭게 변경 가능

예시: `similarity=70` → `threshold=0.30`
- Layer 1~3 (weight > 0.30): 기준 상품의 노선/호텔/관광지 유지
- Layer 4~5 (weight ≤ 0.30): 액티비티/테마 자유 변경

---

## 10. 전체 데이터 흐름 요약

```
사용자 요청 (PlanningInput)
    │
    ▼
AgentCore Runtime (agentcore_app.py)
    │
    ▼
Planning Graph DAG
    │
    ├── ParseInputNode: 입력 파싱 + 유사도 규칙 계산
    │
    ├── CollectContextNode:
    │       │
    │       ├── Valkey 캐시 확인 (SHA256 키)
    │       │
    │       ├── MCP call_tool_sync(prefixed("tool"), args)
    │       │       │
    │       │       ├── SigV4 서명 HTTP → AgentCore Gateway
    │       │       │       │
    │       │       │       ├── Gateway → Lambda Invoke
    │       │       │       │       │
    │       │       │       │       ├── Valkey 캐시 확인 (MD5 키)
    │       │       │       │       ├── Gremlin 쿼리 → Neptune
    │       │       │       │       ├── Valkey 캐시 저장
    │       │       │       │       └── JSON 결과 반환
    │       │       │       │
    │       │       │       └── MCP ToolResult 반환
    │       │       │
    │       │       └── 결과 수신
    │       │
    │       └── Valkey 캐시 저장 → graph_context 저장
    │
    ├── GenerateSkeletonNode (Sonnet, 수집된 컨텍스트만 사용)
    │
    ├── ValidateSkeletonNode → 실패 시 재시도
    │
    ├── GenerateDayDetailsNode (Opus ×N 병렬, MCP + CacheHook)
    │
    └── ValidateDayDetailsNode → 실패 시 해당 날만 재시도
    │
    ▼
DynamoDB 저장 (save_product via MCP)
    │
    ▼
SSE 스트리밍 결과 → 클라이언트
```
