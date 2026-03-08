# GraphRAG + Amazon Bedrock AgentCore로 구축하는 AI 여행상품 기획 에이전트

## AWS Summit Seoul 2026 — 발표자료 (15분)

**청중**: 개발자, 기획자, 엔지니어
**트랙**: AI/ML

---

## Slide 1: 타이틀

**GraphRAG + Amazon Bedrock AgentCore**
AI 여행상품 기획 에이전트를 구축하며 배운 것들

발표자: ___
AWS Summit Seoul 2026

---

## Slide 2: 아젠다 (20초)

1. 문제: Conventional RAG로 왜 안 됐나
2. 해법: GraphRAG — Knowledge Graph + LLM
3. 아키텍처: Bedrock AgentCore로 에이전트 호스팅
4. 결과: PoC 100개 패키지로 검증한 것
5. 배운 것과 코드 레벨 인사이트

---

## Slide 3: 프로젝트 소개 (1분)

### 여행 패키지 상품을 AI가 기획합니다

**입력**: "오사카 3박, 벚꽃 시즌, 온천 테마, 예산 150만원"
**출력**: 완성된 패키지 상품 (일자별 일정, 관광지, 호텔, 항공편, 가격)

**PoC 규모**: 약 100개 기존 패키지 → Knowledge Graph 구축 → AI 에이전트가 신규 상품 생성

**기술 스택**:
- **Amazon Neptune** — Knowledge Graph (도시/관광지/호텔/노선 관계)
- **Amazon Bedrock** — Claude Sonnet 4.6 + Opus 4.6
- **Amazon Bedrock AgentCore** — Runtime(에이전트 호스팅) + Gateway(MCP 도구)
- **Next.js** — Web UI
- **DynamoDB** — 생성 상품 저장

---

## Slide 4: 왜 Conventional RAG로 안 됐나 (2분)

### 문서 기반 검색의 한계

```
100개 패키지를 벡터DB에 저장
    ↓
"오사카 3박" → 유사 문서 검색 → LLM에 컨텍스트 주입
    ↓
LLM이 새 상품 생성
```

### 발생한 문제 3가지

**1. 환각 (Hallucination)**
```
입력: "교토 하루 일정"
출력: "교토 황금 정원, 사쿠라 테라스..." ← 존재하지 않는 관광지
```
검색 결과에 충분한 정보가 없으면 LLM이 **자기 지식으로 만들어냄**

**2. 관계 추론 불가**
```
"유후인 근처 관광지" → 벡터 검색으로 "근처" 관계를 표현할 수 없음
"온천이 있는 호텔이 포함된 패키지" → 6개 테이블 JOIN 필요
```

**3. 확장성 문제**
트렌드 데이터 추가 → 별도 인덱스 + 별도 파이프라인 + 통합 로직
→ 소스가 늘수록 복잡도 기하급수적 증가

---

## Slide 5: GraphRAG — 문서에서 관계로 (2분)

### 같은 100개 데이터를 "관계"로 재구성

```
Package ──VISITS──▶ City ──HAS_ATTRACTION──▶ Attraction
   │                  │
   ├──INCLUDES_HOTEL──▶ Hotel ◀──HAS_HOTEL── City
   │
   ├──DEPARTS_ON──▶ Route ──TO──▶ City
   ├──TAGGED──▶ Theme
   ├──SIMILAR_TO──▶ Package
   └──POPULAR_IN──▶ Season

City ──IN_REGION──▶ Region ──BELONGS_TO──▶ Country
City ──NEAR──▶ City

TrendSpot ──LOCATED_IN──▶ City
```

**12종 노드, 16종 엣지, 총 5,800개 관계**

### Conventional RAG vs GraphRAG

| | Conventional RAG | GraphRAG |
|---|---|---|
| 검색 단위 | 문서 | 엔티티 + 관계 |
| "교토 관광지" | 교토 문서에서 추출 시도 | `City→HAS_ATTRACTION` 순회 |
| "유후인 근처" | 표현 불가 | `City→NEAR→City` 3홉 순회 |
| 트렌드 추가 | 새 파이프라인 | `TrendSpot→LOCATED_IN→City` 엣지 추가 |
| 환각 방지 | 프롬프트에 의존 | **Graph에 있는 데이터만 사용** (구조적 차단) |

---

## Slide 6: 아키텍처 — Bedrock AgentCore 기반 (2분)

### 전체 구조

```
┌─────────────────────────────────────────────────────┐
│                    Web UI (Next.js)                   │
│         폼 입력 / 대화 / 그래프 탐색기 / 트렌드        │
└──────────────┬───────────────────┬──────────────────┘
               │ SSE              │ SSE
               ▼                  ▼
┌──────────────────────┐  ┌──────────────────────────┐
│  AgentCore Runtime   │  │    AgentCore Runtime     │
│  Planning Agent      │  │    Trend Collector Agent  │
│  (Opus + Sonnet)     │  │    (Sonnet)              │
│  ┌────────────────┐  │  │  ┌────────────────────┐  │
│  │ 2-Phase 파이프라인 │  │  │  YouTube/Naver/     │  │
│  │ Skeleton→DayDetail│ │  │  │  Google Trends/News │  │
│  └───────┬────────┘  │  │  └──────────┬─────────┘  │
└──────────┼───────────┘  └─────────────┼────────────┘
           │ MCP                        │ MCP
           ▼                            ▼
┌─────────────────────────────────────────────────────┐
│              AgentCore Gateway (MCP)                  │
│           AWS_IAM 인증 + SigV4 서명                   │
│  ┌─────────────────┐  ┌───────────────────────────┐ │
│  │ travel-tools    │  │ trend-collector            │ │
│  │ (16개 도구)      │  │ (4개 도구)                 │ │
│  └────────┬────────┘  └──────────┬────────────────┘ │
└───────────┼──────────────────────┼──────────────────┘
            ▼                      ▼
┌────────────────────┐  ┌────────────────────────────┐
│ Lambda: travel-tools│ │ Lambda: trend-collector     │
│ (VPC — Neptune 접근)│  │ (Public — 외부 API 호출)    │
└─────┬─────┬────────┘  └────────────────────────────┘
      │     │
      ▼     ▼
  Neptune  DynamoDB
```

### 왜 AgentCore인가?

| 요소 | 역할 | 직접 구축 시 |
|------|------|------------|
| **Runtime** | 에이전트 서버리스 호스팅, 자동 스케일링 | ECS/EKS + 로드밸런서 + 오토스케일링 |
| **Gateway (MCP)** | Lambda를 MCP 도구로 변환, IAM 인증 | API Gateway + 커스텀 MCP 서버 |
| **SigV4 인증** | 에이전트↔도구 간 자동 인증 | 토큰 관리 + 인증 미들웨어 |

> AgentCore가 **인프라 관리를 추상화**해서, 에이전트 로직에만 집중할 수 있었습니다.

---

## Slide 7: Planning Agent — 2-Phase 생성 (2분)

### Phase 1: Skeleton (Sonnet)

```python
# 도구 없음 — Graph Context가 user message에 포함
# 출력: 도시배분, 항공편, 호텔, 가격

graph_context = {
    "reference_package": {...},       # 참고 상품 (MCP: get_package)
    "search_results": [...],          # 유사 상품 (MCP: search_packages)
    "routes": [...],                  # 항공 노선 (MCP: get_routes_by_region)
    "city_attractions": {"오사카": [...], "교토": [...]},  # 도시별 관광지
    "city_hotels": {"오사카": [...]}   # 도시별 호텔
}
```

Sonnet이 이 컨텍스트를 기반으로 **골격만 생성** (관광지 상세 없음)

### Phase 2: Day Detail (Opus × N일)

```python
# MCP 도구 직접 호출 가능
# 핵심 규칙: "get_attractions_by_city를 먼저 호출하고, 결과에 있는 관광지만 사용"

for day in skeleton.day_allocations:
    attractions = mcp.call("get_attractions_by_city", city=day.city)
    trends = mcp.call("get_trends", country="일본")
    # Graph 데이터만으로 일정 구성 → 환각 구조적 차단
```

### 5-Layer 유사도 시스템

```
유사도 50% 요청 시:
Layer 1 [route]      (0.95): RETAIN      ← 도시/노선 유지
Layer 2 [hotel]      (0.70): RETAIN      ← 호텔 유지
Layer 3 [attraction] (0.50): MODIFY      → get_attractions_by_city
Layer 4 [activity]   (0.30): MODIFY      → get_trends
Layer 5 [theme]      (0.10): MODIFY      → search_packages
```

> MODIFY 레이어에 **어떤 MCP 도구를 써야 하는지** 프롬프트에 명시
> → 에이전트가 Graph에서 대안을 찾아 교체

---

## Slide 8: MCP Gateway — Lambda를 도구로 변환 (1분)

### AgentCore Gateway 구조

```
에이전트 → MCP protocol → Gateway → Lambda 호출
                          (도구 스키마 정의)

Target: travel-tools (16개 도구)
├── get_package, search_packages
├── get_attractions_by_city, get_hotels_by_city
├── get_routes_by_region, get_nearby_cities
├── get_trends, get_similar_packages
├── get_cities_by_country          ← Graph 기반 트렌드 수집용
├── upsert_trend, upsert_trend_spot, link_trend_to_spot
└── save_product, get_product, list_products, delete_product

Target: trend-collector (4개 도구)
├── youtube_search
├── naver_search
├── google_trends
└── news_crawl
```

### 포인트

- Lambda는 **순수 함수** — Gremlin 쿼리만 실행
- Gateway가 **MCP 프로토콜 변환 + IAM 인증** 처리
- 에이전트는 도구가 Lambda인지 API인지 **모름** — MCP 인터페이스만 알면 됨
- 도구 추가 = Gateway에 스키마 등록 + Lambda 함수 추가

---

## Slide 9: 환각 방지 — 프롬프트 그라운딩 (1분)

### Graph 데이터 있어도, 프롬프트가 안내하지 않으면 LLM은 여전히 환각

**Before** (Graph는 풍부하지만 프롬프트가 약함):
```
"해당 도시의 관광지 후보를 조회하세요" ← 선택사항 취급 → LLM이 무시하고 일반 지식 사용
```

**After** (Grounding Rule 명시):
```
⚠️ Graph 데이터 기반 규칙 (필수 — 위반 시 전체 재생성)

- 반드시 get_attractions_by_city를 먼저 호출
- 조회된 목록에 있는 이름만 사용 (임의 생성 금지)
- name 필드를 정확히 그대로 사용 (오타/약칭 금지)
- 카테고리별 다양하게 배치 (신사/자연/문화/쇼핑)
- family_friendly=true → 가족여행 시 우선 배치
```

> **GraphRAG의 품질 = Graph 데이터 품질 × 프롬프트 그라운딩**
> 둘 중 하나라도 약하면 환각이 발생합니다.

---

## Slide 10: PoC 결과 — 수치 (1분)

### 100개 패키지에서 구축한 Knowledge Graph

| 항목 | 규모 |
|---|---|
| 노드 | 916개 (12종: Package, City, Attraction, Hotel, Route...) |
| 엣지 | 5,800개 (16종: VISITS, HAS_ATTRACTION, SIMILAR_TO...) |
| 도시↔관광지 | **545개** (AI가 각 도시의 실제 관광지를 앎) |
| 상품 간 유사도 | **469쌍** (변형 상품 생성 기반) |

### 개선 효과

| 지표 | Conventional RAG | GraphRAG |
|---|---|---|
| 도시↔관광지 연결 | 2개 | **545개** |
| 관광지 환각 | 빈번 | **구조적 차단** |
| 트렌드 연동 | 별도 시스템 | **엣지 추가로 즉시** |
| 1건 기획 비용 | - | **~$1.30** (Opus 92%) |
| 1건 소요시간 | 2~3일 (수작업) | **2~3분** |

---

## Slide 11: 트렌드 수집 에이전트 — Graph 기반 (1분)

### Country → City 기반 수집

```
기존: collect("규슈") → AI가 도시명을 추측 → 52% 연결 성공
개선: collect("일본") → get_cities_by_country("일본")
                       → [후쿠오카, 오사카, 교토, 벳푸...]
                       → 도시별 YouTube/Naver/News 수집
                       → TrendSpot → LOCATED_IN → City (정확한 연결)
```

### 에이전트 프롬프트의 핵심

```
0단계: get_cities_by_country(country) 호출 (필수)
1단계: 확보한 도시명으로 각 소스 검색
3단계: link_trend_to_spot의 city_name에 0단계 도시명을 그대로 사용
```

> **패턴**: "Graph에서 먼저 조회 → 그 데이터만 사용"
> Planning Agent와 동일한 그라운딩 원칙을 Trend Agent에도 적용

---

## Slide 12: 배포 — AgentCore Runtime (1분)

### 에이전트 배포가 이렇게 간단합니다

```bash
# 1. BedrockAgentCoreApp으로 래핑
from bedrock_agentcore.runtime import BedrockAgentCoreApp
app = BedrockAgentCoreApp()

@app.entrypoint
async def invoke(payload, context):
    agent = create_planning_agent()
    async for event in agent.stream_async(prompt):
        yield event

# 2. 배포 (Docker 불필요)
agentcore configure --entrypoint agentcore_app.py
agentcore launch --env "GATEWAY_MCP_URL=https://..."
```

### 운영 중인 에이전트

| 에이전트 | 모델 | 네트워크 | 역할 |
|---------|------|---------|------|
| ota_travel_agent | Opus 4.6 | VPC (Neptune) | 상품 기획 |
| ota_trend_collector | Sonnet 4.6 | Public (외부 API) | 트렌드 수집 |

- 서버 관리 없음 (서버리스)
- VPC 설정으로 Neptune 직접 접근
- 환경변수로 Gateway URL 주입

---

## Slide 13: 배운 것 — 3가지 인사이트 (1분)

### 1. RAG의 품질은 "검색 전략"이 결정합니다

```
같은 LLM + 같은 데이터:
  문서로 주면 → 추측 (환각)
  관계로 주면 → 사실 기반 (그라운딩)
```

### 2. 프롬프트 그라운딩이 Graph만큼 중요합니다

Graph를 아무리 풍부하게 만들어도 프롬프트에 **"Graph 데이터만 사용하라"**고 명시하지 않으면 LLM은 여전히 일반 지식을 씁니다.

### 3. AgentCore가 인프라 복잡도를 흡수합니다

MCP Gateway(도구 관리) + Runtime(호스팅) + IAM(인증)
→ 에이전트 로직에만 집중할 수 있었습니다.

> **직접 구축했다면**: ECS 클러스터 + ALB + 오토스케일링 + API Gateway + 커스텀 MCP 서버 + 인증 미들웨어
> **AgentCore**: `agentcore launch` 한 줄

---

## Slide 14: 핵심 메시지

### "AI에게 가이드북을 주지 말고, 네비게이션을 주세요"

```
Conventional RAG:
  벡터DB → 유사 문서 → LLM이 추측으로 생성

GraphRAG + AgentCore:
  Neptune Graph → MCP 도구로 관계 탐색 → LLM이 사실 기반 생성
  AgentCore Runtime → 서버리스 호스팅
  AgentCore Gateway → Lambda를 MCP 도구로 자동 변환
```

**결과:**
- 환각 **구조적 차단** — Graph에 있는 데이터만 사용
- 확장이 쉬움 — 엣지 하나 + 도구 하나 추가
- 운영 부담 최소화 — AgentCore가 인프라 추상화

> **GraphRAG는 LLM의 "추측"을 "탐색"으로 바꾸고,**
> **AgentCore는 에이전트의 "운영"을 "배포"로 바꿉니다.**

---

## Slide 15: Q&A + 리소스

감사합니다.

**참고 리소스:**
- Amazon Neptune: aws.amazon.com/neptune
- Amazon Bedrock AgentCore: aws.amazon.com/bedrock/agentcore
- Strands Agents SDK: github.com/strands-agents

---

## 발표 노트

### 시간 배분 가이드 (15분)
| 구간 | 슬라이드 | 시간 | 핵심 |
|---|---|---|---|
| 문제 정의 | 1-4 | 3분 | RAG 한계, 환각 문제 |
| GraphRAG | 5 | 2분 | 그래프 스키마, 비교표 |
| 아키텍처 | 6-8 | 4분 | AgentCore 구조, 2-Phase, MCP Gateway |
| 결과 | 9-11 | 3분 | 그라운딩, 수치, 트렌드 |
| 배포+마무리 | 12-15 | 3분 | AgentCore Runtime, 인사이트, Q&A |

### 발표 팁
- Slide 4: 실제 환각 예시를 라이브로 보여주면 개발자 청중이 즉시 공감
- Slide 5: 그래프 스키마 다이어그램을 애니메이션으로 — 노드가 하나씩 연결되는 효과
- Slide 6: 아키텍처 다이어그램을 1분 이내로 빠르게 — 디테일보다 "왜 이 구조인지"에 집중
- Slide 7: 코드 스니펫은 핵심 3줄만 하이라이트, 나머지는 흐리게
- Slide 12: `agentcore launch` 라이브 데모 또는 터미널 스크린샷
- Slide 14: "추측→탐색, 운영→배포" 두 문장을 천천히 강조

### 예상 질문과 답변

**Q: Neptune 대신 Neo4j를 써도 되나요?**
A: 네, GraphRAG 패턴 자체는 그래프DB 종류에 의존하지 않습니다. 다만 AWS 생태계(AgentCore Gateway, Lambda, IAM)와의 통합은 Neptune이 자연스럽습니다.

**Q: MCP Gateway 없이 직접 Lambda를 호출하면 안 되나요?**
A: 가능합니다. 하지만 Gateway가 MCP 프로토콜 변환, 도구 스키마 관리, IAM 인증을 자동 처리합니다. 에이전트 프레임워크(Strands, LangGraph 등)가 MCP를 네이티브 지원하므로, Gateway를 쓰면 도구 통합 코드가 사라집니다.

**Q: Opus 비용이 부담되는데, Sonnet만으로 가능한가요?**
A: Skeleton은 이미 Sonnet입니다. Day Detail을 Sonnet으로 전환하면 1건당 $1.30 → $0.15로 줄지만 관광지 선택 품질이 낮아집니다. Batch API(50% 할인)나 Prompt Caching으로 비용 최적화를 먼저 추천합니다.

**Q: 그래프 구축 자동화는 어떻게 하나요?**
A: 기존 상품 데이터를 크롤링 → 구조화 JSON 변환 → Gremlin으로 Neptune 적재하는 파이프라인을 구축했습니다. 한번 파이프라인이 만들어지면 신규 상품 추가는 자동입니다.

**Q: AgentCore Runtime에서 VPC 접근이 되나요?**
A: 네, `agentcore configure`에서 `--vpc --subnets --security-groups` 옵션으로 VPC 네트워킹을 설정할 수 있습니다. Planning Agent는 VPC 모드로 Neptune에 직접 접근합니다.
