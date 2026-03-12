# OTA Travel Agent — GraphRAG 기반 여행상품 기획 AI

여행사 패키지 상품 MD(Merchandiser)가 새로운 여행 패키지를 기획할 때, **Knowledge Graph 기반 AI Agent**가 초안 일정을 자동 생성하는 시스템입니다.

> **기존 방식**(RDBMS + Vector RAG)의 낮은 정확도, 높은 비용(EC2 8대) 문제를 해결하기 위해, **Neptune GraphRAG + Serverless** 아키텍처로 전환한 프로젝트입니다.

---

## 핵심 특징

- **Knowledge Graph 단일 데이터 소스** — Neptune Graph DB에 패키지·도시·관광지·호텔·노선·트렌드를 그래프로 저장
- **2-Phase 생성** — Sonnet(구조) → Opus(상세) 순차 생성으로 비용 최적화 + 품질 확보
- **5-Layer 유사도 다이얼** — 기존 상품 대비 0~100% 연속 조절로 변경 범위 제어
- **트렌드 실시간 반영** — YouTube, Naver, Google Trends, 뉴스에서 수집한 트렌드를 상품에 반영
- **프롬프트 최적화** — Phase별 컨텍스트 필터링 + Bedrock Prompt Caching으로 토큰 76% 절감
- **전구간 SSE 스트리밍** — 30초+ 생성 과정을 실시간으로 표시

---

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                    브라우저 (MD 사용자)                          │
│   챗 모드 · 폼 모드 · 트렌드 대시보드 · 그래프 탐색(Cytoscape)  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ SSE / REST
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Next.js (CloudFront → EC2)                                     │
│  Cloudscape Design System · React 19 · TypeScript               │
│  /api/planning → AgentCore | /api/graph/* → Neptune 직접 조회   │
└──────────┬──────────────────────────────────┬───────────────────┘
           │ SigV4                            │ Gremlin WSS
           ▼                                  ▼
┌──────────────────┐                 ┌─────────────────┐
│ AgentCore        │                 │ Amazon Neptune   │
│ Runtime          │                 │ Serverless       │
│                  │                 │ (Knowledge Graph)│
│ Travel Agent     │                 └─────────────────┘
│ Trend Collector  │                          ▲
└────────┬─────────┘                          │
         │ MCP (SigV4)                        │ Gremlin
         ▼                                    │
┌─────────────────────────────────────────────┴───────────────────┐
│ AgentCore Gateway (AWS_IAM)                                     │
│ travel-tools (17 tools) │ trend-collector (4 tools)             │
└──────────┬──────────────────────────────────┬───────────────────┘
           │ Lambda Invoke                    │ Lambda Invoke
           ▼                                  ▼
┌──────────────────────┐        ┌──────────────────────────┐
│ ota-travel-tools     │        │ ota-trend-collector      │
│ (VPC — Neptune/DDB)  │        │ (Public — 외부 API)      │
└──────────────────────┘        └──────────────────────────┘
```

---

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| **AI Agent** | [Strands Agents SDK](https://github.com/strands-agents/sdk-python), Claude Opus 4.6 / Sonnet 4.6 |
| **Agent 배포** | Amazon Bedrock AgentCore Runtime |
| **도구 연결** | AgentCore Gateway (MCP Protocol, AWS_IAM) |
| **Graph DB** | Amazon Neptune Serverless (Gremlin) |
| **캐싱** | Amazon ElastiCache Serverless (Valkey) |
| **스토리지** | Amazon DynamoDB (AI 생성 상품) |
| **컴퓨팅** | AWS Lambda (Python 3.11) |
| **프론트엔드** | Next.js 15, React 19, Cloudscape Design System, Cytoscape.js |
| **CDN** | Amazon CloudFront (VPC Origin → EC2) |
| **IaC** | AWS CDK (TypeScript, 6개 스택) |

---

## 프로젝트 구조

```
travel-md/
├── agent/                    # 여행 기획 에이전트 (Strands + AgentCore)
│   └── src/
│       ├── agentcore_app.py  #   프로덕션 진입점
│       ├── agents/           #   5개 에이전트 (ChatParser, Skeleton, DayDetail, Conversational, Itinerary)
│       ├── orchestrator/     #   6-노드 DAG 파이프라인
│       ├── prompts/          #   시스템 프롬프트 (한국어)
│       ├── models/           #   Pydantic 데이터 모델
│       ├── similarity/       #   5-Layer 유사도 계산
│       ├── validator/        #   프로그래밍 검증 엔진
│       ├── cache.py          #   Valkey 캐싱 레이어
│       └── hooks/            #   Strands 캐시 훅
│
├── trend-agent/              # 트렌드 수집 에이전트
│   └── src/
│       ├── agentcore_app.py
│       └── agents/collector.py
│
├── infra/
│   ├── cdk/                  # CDK IaC (6개 스택)
│   │   ├── lib/
│   │   │   ├── network-stack.ts      # VPC, Security Groups
│   │   │   ├── data-stack.ts         # Neptune, Valkey, DynamoDB
│   │   │   ├── lambda-stack.ts       # Lambda 함수 2개
│   │   │   ├── gateway-stack.ts      # AgentCore Gateway + Targets
│   │   │   ├── agent-stack.ts        # AgentCore Runtime 2개
│   │   │   └── web-hosting-stack.ts  # EC2, CloudFront, S3
│   │   └── schemas/                  # Gateway 도구 스키마 (JSON)
│   ├── lambda/               # ota-travel-tools Lambda 소스
│   ├── trend-collector-lambda/  # ota-trend-collector Lambda 소스
│   └── scripts/              # 배포 스크립트
│
├── web/                      # Next.js 프론트엔드
│   └── src/
│       ├── app/              #   페이지 + API Routes
│       ├── components/       #   Cloudscape UI 컴포넌트
│       ├── hooks/            #   커스텀 훅
│       └── lib/              #   agentcore, gremlin, dynamodb, valkey 클라이언트
│
├── docs/                     # 아키텍처, 비용 추정, 보안 감사 문서
├── Makefile                  # 빌드/배포 태스크 러너
└── .env.example              # 환경 변수 템플릿
```

---

## 시작하기

### 사전 요구사항

- **AWS 계정** — Neptune, ElastiCache, Lambda, AgentCore, Bedrock 접근 권한
- **Node.js 22+** (프론트엔드)
- **Python 3.11+** (에이전트/Lambda)
- **AWS CDK CLI** (`npm install -g aws-cdk`)

### 1. 인프라 배포 (CDK)

```bash
cd infra/cdk
npm install
cdk bootstrap   # 최초 1회
cdk deploy --all
```

6개 스택이 순서대로 배포됩니다: Network → Data → Lambda → Gateway → Agent → Web

### 2. 에이전트 로컬 개발

```bash
make install-agent
cp .env.example .env          # 환경 변수 설정
make agent                    # localhost:8080
```

### 3. 프론트엔드 로컬 개발

```bash
make install-web
make frontend                 # localhost:3000
```

### 4. 웹 앱 배포

```bash
./infra/scripts/deploy-web.sh   # Next.js 빌드 → S3 → EC2 (SSM)
```

---

## CDK 인프라 스택

| 스택 | 리소스 | 설명 |
|------|--------|------|
| `OtaNetworkStack` | VPC, Subnets, NAT, Security Groups | 2-AZ VPC, Neptune/Valkey SG |
| `OtaDataStack` | Neptune Serverless, Valkey Serverless, DynamoDB | 데이터 레이어 전체 |
| `OtaLambdaStack` | Lambda ×2 | travel-tools (VPC), trend-collector (Public) |
| `OtaGatewayStack` | AgentCore Gateway, Targets ×2 | MCP Gateway + 도구 스키마 등록 |
| `OtaAgentStack` | AgentCore Runtime ×2 | travel-agent (VPC), trend-collector (Public) |
| `OtaWebStack` | EC2, CloudFront, S3 | Next.js 호스팅 + CDN |

```bash
# 개별 스택 배포
cdk deploy OtaLambdaStack

# 전체 배포
cdk deploy --all

# 변경사항 확인
cdk diff
```

---

## MCP 도구 카탈로그 (21개)

### travel-tools (17개)

| 분류 | 도구 | 설명 |
|------|------|------|
| Graph 읽기 (9) | `get_package`, `search_packages`, `get_routes_by_region`, `get_attractions_by_city`, `get_hotels_by_city`, `get_trends`, `get_similar_packages`, `get_nearby_cities`, `get_cities_by_country` | Neptune Gremlin 조회 |
| Graph 쓰기 (3) | `upsert_trend`, `upsert_trend_spot`, `link_trend_to_spot` | 트렌드 데이터 적재 |
| DynamoDB (4) | `save_product`, `get_product`, `list_products`, `delete_product` | AI 생성 상품 CRUD |
| 캐시 (1) | `invalidate_cache` | Valkey 캐시 무효화 |

### trend-collector (4개)

| 도구 | 외부 API |
|------|---------|
| `youtube_search` | YouTube Data API v3 |
| `naver_search` | Naver Blog + Cafe API |
| `google_trends` | Google Trends (pytrends) |
| `news_crawl` | Naver News + Google News RSS |

---

## 환경 변수

`.env.example` 참조:

```bash
# Neptune
GREMLIN_ENDPOINT=wss://<CLUSTER>.cluster-<ID>.<REGION>.neptune.amazonaws.com:8182/gremlin

# Valkey
REDIS_HOST=<CACHE_NAME>.serverless.<REGION_SHORT>.cache.amazonaws.com
REDIS_PORT=6379

# AgentCore
AGENTCORE_AGENT_ARN=arn:aws:bedrock-agentcore:<REGION>:<ACCOUNT_ID>:runtime/<AGENT_ID>
GATEWAY_MCP_URL=https://<GATEWAY_ID>.gateway.bedrock-agentcore.<REGION>.amazonaws.com/mcp

# AWS
AWS_REGION=ap-northeast-2

# DynamoDB
DYNAMODB_TABLE_NAME=ota-planned-products

# Trend Collector (선택)
YOUTUBE_API_KEY=...
NAVER_CLIENT_ID=...
NAVER_CLIENT_SECRET=...
```

---

## 문서

| 문서 | 설명 |
|------|------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 전체 아키텍처, 데이터 모델, 시퀀스 다이어그램 |
| [why-graphrag.md](docs/why-graphrag.md) | GraphRAG 도입 근거 |
| [cost-estimation.md](docs/cost-estimation.md) | 월간 비용 추정 |
| [security-audit](docs/security-audit-2026-03-11.md) | 보안 감사 보고서 |

---

## 라이선스

이 프로젝트는 내부 프로젝트입니다.
