# RDBMS + Conventional RAG로 구현한다면?

> OTA 여행상품 기획 시스템을 GraphRAG(Neptune) 대신 RDBMS + Vector RAG로 설계하는 경우의 구체적 설계안과 트레이드오프 분석

---

## 1. 전제

현재 시스템의 핵심 기능을 동일하게 구현한다고 가정한다:
- 12종 그래프 엔티티(Package, Country, Region, City, Attraction, Hotel, Airline, Route, Theme, Season, Trend, TrendSpot)
- 18종 관계(VISITS, INCLUDES, HAS_ATTRACTION, HAS_HOTEL, NEAR, SIMILAR_TO, FILMED_AT, FEATURES, LOCATED_IN, IN_COUNTRY, IN_REGION, BELONGS_TO, OPERATES, TO, INCLUDES_HOTEL, DEPARTS_ON, TAGGED, POPULAR_IN)
- 5-Layer 유사도 제어, 2-Phase 생성, 트렌드 시간 감쇠, 트렌드 Tier 분류(hot/steady/seasonal), 트렌드 배합 비율, 다조건 패키지 검색

**기술 스택 (대안)**:
- **RDBMS**: Amazon Aurora PostgreSQL (+ pgvector 확장)
- **벡터 저장소**: pgvector (Aurora 내장) 또는 Amazon OpenSearch Serverless
- **임베딩 모델**: Amazon Titan Embeddings v2
- **나머지**: 동일 (AgentCore Runtime, Lambda, Bedrock Claude)

---

## 2. RDBMS 스키마 설계

### 2.1 엔티티 테이블 (13개)

```sql
-- 기본 엔티티 (현재 Graph vertex → 테이블)
CREATE TABLE packages (
    id          SERIAL PRIMARY KEY,
    code        VARCHAR(30) UNIQUE NOT NULL,
    name        TEXT,
    price       INTEGER,
    nights      INTEGER,
    days        INTEGER,
    rating      NUMERIC(3,1),
    region      VARCHAR(50),
    country     VARCHAR(50),
    season      JSONB,              -- ["봄","여름"]
    hashtags    JSONB,              -- ["#온천","#미식"]
    shopping_count INTEGER DEFAULT 0,
    description TEXT,
    source_url  TEXT,
    guide_fee   JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE cities (
    id      SERIAL PRIMARY KEY,
    name    VARCHAR(100) NOT NULL,
    region  VARCHAR(100),
    country VARCHAR(100),
    voltage VARCHAR(20),
    UNIQUE(name, country)
);

CREATE TABLE attractions (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    category    VARCHAR(50),
    description TEXT,
    city_id     INTEGER REFERENCES cities(id)   -- ★ HAS_ATTRACTION 간선 → FK
);

CREATE TABLE hotels (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    name_en     VARCHAR(200),
    grade       VARCHAR(50),
    has_onsen   BOOLEAN DEFAULT FALSE,
    city_id     INTEGER REFERENCES cities(id)   -- ★ HAS_HOTEL 간선 → FK
);

CREATE TABLE routes (
    id              SERIAL PRIMARY KEY,
    flight_number   VARCHAR(20),
    airline         VARCHAR(50),
    airline_type    VARCHAR(10),   -- FSC / LCC
    departure_city  VARCHAR(100),
    departure_time  VARCHAR(10),
    arrival_time    VARCHAR(10),
    duration        VARCHAR(20),
    arrival_city_id INTEGER REFERENCES cities(id)  -- ★ TO 간선 → FK
);

CREATE TABLE themes (
    id   SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL
);

CREATE TABLE activities (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    description TEXT
);

CREATE TABLE trends (
    id              SERIAL PRIMARY KEY,
    title           VARCHAR(300) NOT NULL,
    type            VARCHAR(50),
    source          VARCHAR(50),
    date            DATE,
    virality_score  INTEGER,
    decay_rate      NUMERIC(3,2),
    tier            VARCHAR(10) DEFAULT 'hot',  -- hot / steady / seasonal
    keywords        JSONB,
    evidence        JSONB,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(title, source)
);

CREATE TABLE trend_spots (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(200) NOT NULL,
    description     TEXT,
    category        VARCHAR(50),
    lat             NUMERIC(10,6),
    lng             NUMERIC(10,6),
    photo_worthy    BOOLEAN DEFAULT FALSE,
    city_id         INTEGER REFERENCES cities(id)   -- ★ LOCATED_IN 간선 → FK
);

CREATE TABLE countries (
    id      SERIAL PRIMARY KEY,
    name    VARCHAR(100) UNIQUE NOT NULL,
    code    VARCHAR(10)
);

CREATE TABLE regions (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    country_id  INTEGER REFERENCES countries(id),  -- ★ IN_COUNTRY 간선 → FK
    UNIQUE(name, country_id)
);

CREATE TABLE airlines (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    name_en     VARCHAR(100),
    type        VARCHAR(10),   -- FSC / LCC
    UNIQUE(name)
);

CREATE TABLE seasons (
    id      SERIAL PRIMARY KEY,
    name    VARCHAR(50) UNIQUE NOT NULL   -- 봄, 여름, 가을, 겨울
);
```

### 2.2 관계 테이블 (11개 — 다대다 관계 + 추가 FK)

```sql
-- ★ Graph 간선 → 조인 테이블

-- Package ──VISITS──▶ City (day, order)
CREATE TABLE package_cities (
    package_id  INTEGER REFERENCES packages(id),
    city_id     INTEGER REFERENCES cities(id),
    day         INTEGER,
    visit_order INTEGER,
    PRIMARY KEY (package_id, city_id, day)
);

-- Package ──INCLUDES──▶ Attraction (day, order, layer)
CREATE TABLE package_attractions (
    package_id    INTEGER REFERENCES packages(id),
    attraction_id INTEGER REFERENCES attractions(id),
    day           INTEGER,
    visit_order   INTEGER,
    layer         VARCHAR(20),   -- route/hotel/attraction/activity/theme
    PRIMARY KEY (package_id, attraction_id, day)
);

-- Package ──INCLUDES_HOTEL──▶ Hotel
CREATE TABLE package_hotels (
    package_id INTEGER REFERENCES packages(id),
    hotel_id   INTEGER REFERENCES hotels(id),
    night      INTEGER,
    PRIMARY KEY (package_id, hotel_id, night)
);

-- Package ──DEPARTS_ON──▶ Route
CREATE TABLE package_routes (
    package_id INTEGER REFERENCES packages(id),
    route_id   INTEGER REFERENCES routes(id),
    flight_type VARCHAR(20),   -- departure / return
    PRIMARY KEY (package_id, route_id)
);

-- Package ──TAGGED──▶ Theme
CREATE TABLE package_themes (
    package_id INTEGER REFERENCES packages(id),
    theme_id   INTEGER REFERENCES themes(id),
    PRIMARY KEY (package_id, theme_id)
);

-- Package ──SIMILAR_TO──▶ Package (score)
CREATE TABLE package_similarity (
    package_a_id INTEGER REFERENCES packages(id),
    package_b_id INTEGER REFERENCES packages(id),
    score        NUMERIC(3,2),
    PRIMARY KEY (package_a_id, package_b_id)
);

-- City ──NEAR──▶ City (distance_km)
CREATE TABLE city_distances (
    city_a_id    INTEGER REFERENCES cities(id),
    city_b_id    INTEGER REFERENCES cities(id),
    distance_km  INTEGER,
    PRIMARY KEY (city_a_id, city_b_id)
);

-- Trend ──FILMED_AT/FEATURES──▶ TrendSpot
CREATE TABLE trend_spot_links (
    trend_id    INTEGER REFERENCES trends(id),
    spot_id     INTEGER REFERENCES trend_spots(id),
    edge_label  VARCHAR(20),   -- FILMED_AT / FEATURES
    PRIMARY KEY (trend_id, spot_id)
);

-- Package ──HAS_ACTIVITY──▶ Activity
CREATE TABLE package_activities (
    package_id  INTEGER REFERENCES packages(id),
    activity_id INTEGER REFERENCES activities(id),
    day         INTEGER,
    PRIMARY KEY (package_id, activity_id, day)
);

-- City ──IN_REGION──▶ Region
-- (cities 테이블에 region_id FK 추가로도 가능하지만 명시적 조인 테이블)
ALTER TABLE cities ADD COLUMN region_id INTEGER REFERENCES regions(id);

-- Route ──OPERATES──▶ Airline
ALTER TABLE routes ADD COLUMN airline_id INTEGER REFERENCES airlines(id);

-- Trend ──POPULAR_IN──▶ Season
CREATE TABLE trend_seasons (
    trend_id   INTEGER REFERENCES trends(id),
    season_id  INTEGER REFERENCES seasons(id),
    PRIMARY KEY (trend_id, season_id)
);

-- Theme ──BELONGS_TO──▶ Season (테마-시즌 연결)
CREATE TABLE theme_seasons (
    theme_id   INTEGER REFERENCES themes(id),
    season_id  INTEGER REFERENCES seasons(id),
    PRIMARY KEY (theme_id, season_id)
);
```

**합계**: 엔티티 13 테이블 + 관계 11 테이블 (조인 테이블 9개 + ALTER FK 2개) = **22개 이상 테이블/FK**

현재 Neptune은 vertex/edge를 스키마리스로 저장하지만, RDBMS는 관계마다 별도 조인 테이블 또는 FK가 필요하다. 엔티티 12종, 관계 18종을 표현하면서 테이블 수가 크게 증가한다.

### 2.3 벡터 임베딩 테이블 (Conventional RAG용)

```sql
-- pgvector 확장
CREATE EXTENSION IF NOT EXISTS vector;

-- 패키지 텍스트 임베딩 (RAG 검색용)
CREATE TABLE package_embeddings (
    package_id  INTEGER PRIMARY KEY REFERENCES packages(id),
    content     TEXT,              -- 임베딩 원본 텍스트
    embedding   vector(1024),      -- Titan Embeddings v2 (1024차원)
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 관광지 임베딩 (카테고리/설명 기반 유사 관광지 검색)
CREATE TABLE attraction_embeddings (
    attraction_id INTEGER PRIMARY KEY REFERENCES attractions(id),
    content       TEXT,
    embedding     vector(1024)
);

-- 트렌드 임베딩 (트렌드 연관성 검색)
CREATE TABLE trend_embeddings (
    trend_id    INTEGER PRIMARY KEY REFERENCES trends(id),
    content     TEXT,
    embedding   vector(1024)
);

-- 유사도 검색 인덱스
CREATE INDEX idx_package_emb ON package_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_attraction_emb ON attraction_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX idx_trend_emb ON trend_embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
```

---

## 3. 쿼리 변환 — Graph 순회 → SQL JOIN

### 3.1 `get_package` (1-hop 서브그래프 → 7-way JOIN)

**GraphRAG** — 간선 타입별 순회로 한 번에 수집:
```python
Package → VISITS → City[]
Package → INCLUDES → Attraction[]
Package → INCLUDES_HOTEL → Hotel[]
Package → DEPARTS_ON → Route[]
Package → TAGGED → Theme[]
```

**RDBMS** — 테이블마다 별도 쿼리 (또는 거대한 LEFT JOIN):
```sql
-- 방법 A: 5개 쿼리 실행
SELECT c.* FROM cities c
  JOIN package_cities pc ON pc.city_id = c.id
  WHERE pc.package_id = :pkg_id ORDER BY pc.day, pc.visit_order;

SELECT a.*, pa.day, pa.visit_order, pa.layer FROM attractions a
  JOIN package_attractions pa ON pa.attraction_id = a.id
  WHERE pa.package_id = :pkg_id ORDER BY pa.day, pa.visit_order;

SELECT h.*, ph.night FROM hotels h
  JOIN package_hotels ph ON ph.hotel_id = h.id
  WHERE ph.package_id = :pkg_id ORDER BY ph.night;

SELECT r.*, pr.flight_type FROM routes r
  JOIN package_routes pr ON pr.route_id = r.id
  WHERE pr.package_id = :pkg_id;

SELECT t.name FROM themes t
  JOIN package_themes pt ON pt.theme_id = t.id
  WHERE pt.package_id = :pkg_id;
```

**비교**: GraphRAG 1회 쿼리 → RDBMS 5회 쿼리. 코드 복잡도 5배.

### 3.2 `search_packages` (다조건 필터 → 다중 서브쿼리)

**GraphRAG**:
```python
g.V().hasLabel("Package")
 .where(__.out("VISITS").has("name", destination))
 .where(__.out("TAGGED").has("name", theme))
 .has("season", TextP.containing(season))
 .has("nights", nights)
 .has("price", P.lte(max_budget))
```

**RDBMS**:
```sql
SELECT p.* FROM packages p
WHERE p.id IN (
    SELECT pc.package_id FROM package_cities pc
    JOIN cities c ON c.id = pc.city_id
    WHERE c.name = :destination OR c.region = :destination
)
AND (:theme = '' OR p.id IN (
    SELECT pt.package_id FROM package_themes pt
    JOIN themes t ON t.id = pt.theme_id
    WHERE t.name = :theme
))
AND (:season = '' OR p.season::text LIKE '%' || :season || '%')
AND (:nights = 0 OR p.nights = :nights)
AND (:max_budget = 0 OR p.price <= :max_budget)
AND (:shopping_max < 0 OR p.shopping_count <= :shopping_max)
ORDER BY p.rating DESC
LIMIT 10;
```

**비교**: 동작은 하지만 서브쿼리 중첩이 깊어지고, 각 조건이 별도 JOIN/서브쿼리를 요구. 성능 최적화가 어려움.

### 3.3 `get_trends` (3-hop 순회 + 시간 감쇠 → CTE + 계산)

**GraphRAG**:
```python
g.V().hasLabel("Trend")
 .has("virality_score", P.gte(min_score))
 .where(__.out("FILMED_AT", "FEATURES")          # 1-hop: Trend → TrendSpot
        .where(__.out("LOCATED_IN")               # 2-hop: TrendSpot → City
               .hasLabel("City").has("region", region)))  # 3-hop: City 필터
 .project("trend", "spots")
 .by(__.valueMap(True))
 .by(__.out("FILMED_AT", "FEATURES")
     .where(__.out("LOCATED_IN").has("region", region))
     .valueMap(True).fold())
```

**RDBMS**:
```sql
WITH effective_trends AS (
    SELECT t.*,
           t.virality_score * POWER(1 - t.decay_rate,
               GREATEST(0, EXTRACT(YEAR FROM AGE(NOW(), t.date)) * 12
                         + EXTRACT(MONTH FROM AGE(NOW(), t.date)))
           ) AS effective_score
    FROM trends t
    WHERE t.virality_score >= :min_score
),
filtered_trends AS (
    SELECT DISTINCT et.*
    FROM effective_trends et
    JOIN trend_spot_links tsl ON tsl.trend_id = et.id
    JOIN trend_spots ts ON ts.id = tsl.spot_id
    JOIN cities c ON c.id = ts.city_id
    WHERE c.region = :region
      AND et.effective_score >= :min_score
)
SELECT ft.*,
       json_agg(json_build_object(
           'name', ts.name, 'description', ts.description,
           'category', ts.category, 'lat', ts.lat, 'lng', ts.lng,
           'photo_worthy', ts.photo_worthy
       )) AS spots
FROM filtered_trends ft
JOIN trend_spot_links tsl ON tsl.trend_id = ft.id
JOIN trend_spots ts ON ts.id = tsl.spot_id
JOIN cities c ON c.id = ts.city_id
WHERE c.region = :region
GROUP BY ft.id, ft.title, ft.type, ft.source, ft.date,
         ft.virality_score, ft.decay_rate, ft.keywords,
         ft.evidence, ft.updated_at, ft.effective_score
ORDER BY ft.effective_score DESC
LIMIT 10;
```

**비교**: GraphRAG 10줄 → SQL 30줄. CTE 2단계 + 4-way JOIN + GROUP BY + json_agg. 시간 감쇠 함수를 SQL에서 직접 계산해야 하며, PostgreSQL의 `POWER` 함수로 지수 감쇠를 표현하기 어렵지 않지만 가독성이 급격히 떨어짐.

### 3.4 `get_similar_packages` (1-hop → 자기 참조 JOIN)

**GraphRAG**:
```python
g.V().hasLabel("Package").has("code", package_code)
 .outE("SIMILAR_TO")
 .project("package", "score")
 .by(__.inV().valueMap(True))
 .by(__.values("score"))
```

**RDBMS**:
```sql
SELECT p.*, ps.score AS similarity_score
FROM packages p
JOIN package_similarity ps ON ps.package_b_id = p.id
WHERE ps.package_a_id = (SELECT id FROM packages WHERE code = :package_code)
ORDER BY ps.score DESC
LIMIT 10;
```

**비교**: 이 쿼리는 RDBMS에서도 비교적 단순. 단, `package_similarity` 테이블은 양방향이 필요한 경우 `(A→B, B→A)` 두 행을 저장하거나 `OR` 조건 추가 필요.

### 3.5 `get_nearby_cities` (NEAR 간선 → 자기 참조 JOIN)

**GraphRAG**:
```python
g.V().hasLabel("City").has("name", city)
 .outE("NEAR").has("distance_km", P.lte(max_km))
 .project("city", "distance_km")
 .by(__.inV().valueMap(True))
 .by(__.values("distance_km"))
```

**RDBMS**:
```sql
SELECT c.*, cd.distance_km
FROM cities c
JOIN city_distances cd ON cd.city_b_id = c.id
WHERE cd.city_a_id = (SELECT id FROM cities WHERE name = :city)
  AND cd.distance_km <= :max_km
ORDER BY cd.distance_km ASC;
```

**비교**: 역시 비교적 단순. 단방향/양방향 이슈 동일.

---

## 4. Conventional RAG 설계

### 4.1 임베딩 대상 및 청크 전략

| 엔티티 | 임베딩 텍스트 | 용도 | 청크 수 (추정) |
|--------|-------------|------|---------------|
| Package | `"{name}. {region} {nights}박{days}일. 테마: {themes}. 도시: {cities}. 가격: {price}원"` | 유사 패키지 검색 | ~500 |
| Attraction | `"{name} ({category}): {description}. 위치: {city}"` | 관광지 추천 | ~2,000 |
| Trend | `"{title} ({type}, {source}). 키워드: {keywords}. 스팟: {spots}"` | 트렌드 검색 | ~200 |

**문제 1: 임베딩 텍스트에 구조 정보를 얼마나 넣을 것인가?**

패키지 임베딩에 모든 관광지/호텔/노선을 나열하면 텍스트가 길어져 임베딩 품질이 저하됨. 생략하면 구조 정보가 소실됨. 어느 쪽이든 손해.

**문제 2: 관계 검색이 불가능**

"오사카에 있는 관광지 중 미식 카테고리"를 벡터 검색하면:
- "오사카 미식"과 코사인 유사도가 높은 관광지가 반환됨
- 실제로 오사카에 속하지 않는 관광지(예: "교토 미식거리")가 상위에 올 수 있음
- **정확한 소속(City→HAS_ATTRACTION)은 FK JOIN으로만 보장** 가능

### 4.2 하이브리드 검색 파이프라인

결론적으로, Conventional RAG만으로는 이 시스템을 구현할 수 없다. **RDBMS 구조화 쿼리 + 벡터 검색을 결합한 하이브리드**가 필요:

```
사용자 요청
    │
    ▼
┌─────────────────────────────────────────────────┐
│ Tool Router (LLM이 도구 선택)                     │
│                                                   │
│ ┌─────────────────┐  ┌─────────────────────────┐ │
│ │ 구조화 쿼리 도구  │  │ 벡터 검색 도구            │ │
│ │ (SQL 기반)       │  │ (pgvector / OpenSearch)  │ │
│ │                  │  │                          │ │
│ │ get_package      │  │ search_similar_text      │ │
│ │ search_packages  │  │ find_related_attractions │ │
│ │ get_routes       │  │ discover_trends          │ │
│ │ get_attractions  │  │                          │ │
│ │ get_hotels       │  │                          │ │
│ │ get_trends       │  │                          │ │
│ │ get_similar      │  │                          │ │
│ │ get_nearby       │  │                          │ │
│ └────────┬────────┘  └────────────┬─────────────┘ │
│          │ SQL                     │ Vector Search  │
│          ▼                         ▼               │
│    Aurora PostgreSQL          pgvector / OpenSearch │
└─────────────────────────────────────────────────────┘
```

**현실**: 9개 구조화 쿼리 도구는 **전부 SQL로 재구현**해야 하며, 벡터 검색은 "이런 느낌의 관광지"같은 퍼지 검색에만 추가 가치를 제공한다. 즉 **핵심 기능은 결국 RDBMS의 JOIN이 담당**하게 된다.

---

## 5. 5-Layer 유사도 시스템 — RDBMS 구현

### 5.1 현재 (GraphRAG)

```python
LAYER_TOOL_MAP = {
    "route":      ["get_routes_by_region", "get_nearby_cities"],   # Graph 도구
    "hotel":      ["get_hotels_by_city"],                          # Graph 도구
    "attraction": ["get_attractions_by_city"],                     # Graph 도구
    "activity":   ["get_trends", "get_attractions_by_city"],       # Graph 도구
    "theme":      ["get_trends", "search_packages"],               # Graph 도구
}
```

각 레이어의 RETAIN/MODIFY 결정에 따라 **해당 그래프 도구**를 호출하여 대안 데이터를 수집.

### 5.2 RDBMS 대안

```python
LAYER_SQL_MAP = {
    "route": [
        "SELECT r.* FROM routes r JOIN cities c ON r.arrival_city_id = c.id WHERE c.region = :region",
        "SELECT c2.*, cd.distance_km FROM cities c1 JOIN city_distances cd ON ... WHERE c1.name = :city",
    ],
    "hotel": [
        "SELECT h.* FROM hotels h WHERE h.city_id = (SELECT id FROM cities WHERE name = :city)",
    ],
    "attraction": [
        "SELECT a.* FROM attractions a WHERE a.city_id = (SELECT id FROM cities WHERE name = :city)",
    ],
    "activity": [
        # 30줄짜리 CTE 쿼리 (get_trends SQL 버전)
    ],
    "theme": [
        # search_packages SQL + 벡터 검색 하이브리드
    ],
}
```

**문제**: 레이어별 도구가 SQL 쿼리로 바뀌면서, 도구 추상화가 깨진다. GraphRAG에서는 `get_attractions_by_city("오사카")`라는 단일 도구 호출이 RDBMS에서는 서브쿼리 + FK JOIN으로 변환되어야 하며, LLM이 SQL을 직접 생성하거나 더 많은 래퍼 함수가 필요해진다.

---

## 6. 트렌드 시스템 — RDBMS 구현

### 6.1 시간 감쇠 점수

**GraphRAG**: Python 함수에서 vertex 속성으로 계산:
```python
effective = virality_score * (1 - decay_rate) ** months_elapsed
```

**RDBMS**: SQL에서 동일 계산 가능하지만 매 쿼리마다 반복:
```sql
virality_score * POWER(1 - decay_rate,
    GREATEST(0, DATE_PART('year', AGE(NOW(), date)) * 12
              + DATE_PART('month', AGE(NOW(), date))))
AS effective_score
```

### 6.2 트렌드 → 스팟 → 도시 연결

**GraphRAG**: `Trend → FILMED_AT → TrendSpot → LOCATED_IN → City`

**RDBMS**:
```sql
SELECT t.*, ts.*, c.name AS city_name
FROM trends t
JOIN trend_spot_links tsl ON tsl.trend_id = t.id
JOIN trend_spots ts ON ts.id = tsl.spot_id
JOIN cities c ON c.id = ts.city_id
WHERE c.region = :region;
```

이 부분은 RDBMS에서도 3-way JOIN으로 해결 가능. 다만 그래프의 직관적 순회 대비 가독성이 떨어짐.

### 6.3 트렌드 수집 후 캐시 무효화

**GraphRAG (현재)**: `invalidate_cache` 도구 → Valkey SCAN + DEL

**RDBMS**: 동일 패턴 적용 가능. 차이 없음.

### 6.4 트렌드 Tier 분류 + 배합 비율

**GraphRAG (현재)**:
- Trend vertex에 `tier` 속성 저장 (hot/steady/seasonal)
- `_infer_tier(decay_rate)` fallback으로 기존 노드 호환
- `_distribute_trends_by_tier(trends, {"hot": 70, "steady": 30})` → 비율 기반 배분

**RDBMS**:
```sql
-- tier 컬럼 추가
ALTER TABLE trends ADD COLUMN tier VARCHAR(10);
UPDATE trends SET tier = CASE
    WHEN decay_rate <= 0.10 THEN 'hot'
    WHEN decay_rate <= 0.25 THEN 'steady'
    ELSE 'seasonal' END;

-- 배합 비율 적용은 애플리케이션 로직에서 처리
-- SQL만으로는 "hot 70%, steady 30%" 비율 배분이 어려워
-- WINDOW 함수 + ROW_NUMBER로 근사 구현 필요
```

**비교**: tier 분류 자체는 RDBMS에서도 가능하지만, 배합 비율 기반 동적 배분은 그래프 순회 + Python 로직이 더 자연스럽다.

---

## 7. 비용 비교

### 7.1 인프라 비용 (월간 추정, ap-northeast-2)

| 항목 | GraphRAG (현재) | RDBMS + RAG (대안) |
|------|----------------|-------------------|
| **DB 엔진** | Neptune Serverless (~$200~400/월) | Aurora PostgreSQL Serverless v2 (~$150~300/월) |
| **벡터 저장소** | 불필요 | pgvector (Aurora 내장, 추가 비용 없음) 또는 OpenSearch Serverless (~$200/월) |
| **캐시** | ElastiCache Valkey (~$50/월) | 동일 |
| **임베딩 생성** | 불필요 | Titan Embeddings (~$20/월, 초기 + 변경 시) |
| **합계** | **~$250~450/월** | **~$370~720/월** |

### 7.2 개발/유지보수 비용

| 항목 | GraphRAG | RDBMS + RAG |
|------|----------|-------------|
| **스키마 관리** | 스키마리스 (vertex/edge 자유 추가) | 22개+ 테이블 마이그레이션 관리 |
| **쿼리 복잡도** | Gremlin 5~15줄 | SQL 15~40줄 (JOIN 중첩) |
| **새 관계 추가** | 간선 라벨 1개 추가 | 조인 테이블 1개 + FK + 인덱스 추가 |
| **임베딩 파이프라인** | 불필요 | 엔티티 변경 시 재임베딩 필요 |
| **도구 구현** | 9개 (각 5~30줄 Gremlin) | 9개 (각 15~50줄 SQL) + 벡터 검색 3개 |
| **디버깅** | Graph 시각화 (Cytoscape, 5가지 레이아웃) | SQL EXPLAIN + 벡터 유사도 디버깅 |

---

## 8. RDBMS + RAG가 나은 경우

공정하게 평가하면, 다음 상황에서는 RDBMS가 더 적합할 수 있다:

| 상황 | 이유 |
|------|------|
| **집계/분석 쿼리가 빈번** | "월별 패키지 판매량", "지역별 평균 가격" 등은 SQL GROUP BY가 자연스러움 |
| **트랜잭션 ACID가 필요** | 동시 수정, 롤백, 일관성 보장이 필요한 경우 |
| **팀이 SQL에 익숙** | Gremlin 학습 곡선이 부담인 경우 |
| **단순한 관계 구조** | 관계가 2~3종이고 깊이가 2 이내인 경우 |
| **전문 검색(Full-text)** | PostgreSQL의 tsvector가 강력 |

그러나 이 프로젝트는 위 조건에 해당하지 않는다:
- 집계보다 **관계 순회**가 핵심
- 읽기 위주 워크로드 (ACID 불필요)
- 18종 관계, 최대 3-hop 순회
- 5-Layer 시스템이 관계 구조에 의존

---

## 9. 결론 — 트레이드오프 요약

| 관점 | GraphRAG (Neptune) | RDBMS + RAG (Aurora + pgvector) |
|------|-------------------|-------------------------------|
| **데이터 모델** | 12 vertex + 18 edge (스키마리스) | 22+ 테이블 (엄격한 스키마) |
| **관계 쿼리** | Gremlin 순회 (자연스러움) | 다중 JOIN + 서브쿼리 (복잡) |
| **유사도 검색** | SIMILAR_TO 간선 (구조 기반) | 벡터 코사인 유사도 (텍스트 기반) |
| **5-Layer 제어** | 레이어별 그래프 도구 매핑 | 레이어별 SQL + 벡터 하이브리드 |
| **새 관계 추가** | 간선 1줄 | 테이블 + FK + 인덱스 + 마이그레이션 |
| **시간 감쇠** | Python 함수 (속성 기반) | SQL 수식 (매 쿼리 반복) |
| **그라운딩** | 그래프 엔티티 직접 참조 | SQL 결과 + 벡터 후보 → 교차 검증 필요 |
| **시각화/디버깅** | Cytoscape로 직관적 탐색 (5가지 레이아웃) | ER 다이어그램 + SQL EXPLAIN |
| **임베딩 관리** | 불필요 | 엔티티 변경 시 재생성 파이프라인 필요 |
| **인프라 비용** | 낮음 (~$300/월) | 중간 (~$500/월, 벡터 포함) |
| **러닝 커브** | Gremlin 학습 필요 | SQL 친숙하지만 쿼리 복잡도 높음 |

**핵심**: RDBMS + RAG로도 구현은 가능하다. 그러나 **22개+ 테이블, 다중 JOIN, 별도 벡터 파이프라인**이라는 복잡성을 감수해야 하며, 그래프가 자연스럽게 표현하는 구조적 관계를 **인위적으로 평탄화**하는 비용을 치러야 한다. 여행 상품 도메인에서 이 비용은 GraphRAG를 선택하는 것보다 크다.
