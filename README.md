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
│ Runtime (PUBLIC) │                 │ Serverless       │
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
│ + Valkey 캐싱        │        └──────────────────────────┘
└──────────────────────┘
```

---

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| **AI Agent** | [Strands Agents SDK](https://github.com/strands-agents/sdk-python), Claude Opus 4.6 / Sonnet 4.6 |
| **Agent 배포** | Amazon Bedrock AgentCore Runtime (PUBLIC) |
| **도구 연결** | AgentCore Gateway (MCP Protocol, AWS_IAM) |
| **Graph DB** | Amazon Neptune Serverless (Gremlin) |
| **캐싱** | Amazon ElastiCache Serverless (Valkey) — Lambda 레벨 읽기 캐싱 |
| **스토리지** | Amazon DynamoDB (AI 생성 상품) |
| **컴퓨팅** | AWS Lambda (Python 3.11, ARM64) |
| **프론트엔드** | Next.js 15, React 19, Cloudscape Design System, Cytoscape.js |
| **CDN** | Amazon CloudFront → EC2 (Custom Origin) |
| **IaC** | AWS CloudFormation (단일 스택, 55개 리소스) |

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
│       └── validator/        #   프로그래밍 검증 엔진
│
├── trend-agent/              # 트렌드 수집 에이전트
│   └── src/
│       ├── agentcore_app.py
│       └── agents/collector.py
│
├── infra/
│   ├── travel-md-standalone-stack.yaml  # 단일 CloudFormation 스택 (전체 인프라)
│   ├── lambda/               # ota-travel-tools Lambda 소스
│   └── trend-collector-lambda/  # ota-trend-collector Lambda 소스
│
├── web/                      # Next.js 프론트엔드
│   └── src/
│       ├── app/              #   페이지 + API Routes
│       ├── components/       #   Cloudscape UI 컴포넌트
│       ├── hooks/            #   커스텀 훅
│       └── lib/              #   agentcore, gremlin, dynamodb, valkey 클라이언트
│
├── scripts/                  # 유틸리티 (load_graph.py)
├── docs/                     # 아키텍처, 비용 추정 문서
├── Makefile                  # 빌드/배포 태스크 러너
└── .env.example              # 환경 변수 템플릿
```

---

## 배포

### 사전 요구사항

- **AWS 계정** — Neptune, ElastiCache, Lambda, AgentCore, Bedrock 접근 권한
- **AWS CLI** 설정 완료
- **Bedrock 모델 접근** — Claude Opus 4.6, Sonnet 4.6 활성화

### 원클릭 배포 (CloudFormation)

단일 스택으로 전체 인프라가 배포됩니다:

```bash
aws cloudformation create-stack \
  --stack-name ota-travel-md \
  --template-body file://infra/travel-md-standalone-stack.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region ap-northeast-2
```

배포 진행 상태 확인:
```bash
aws cloudformation describe-stacks \
  --stack-name ota-travel-md \
  --query "Stacks[0].StackStatus" \
  --output text
```

배포 완료 후 URL 확인:
```bash
aws cloudformation describe-stacks \
  --stack-name ota-travel-md \
  --query "Stacks[0].Outputs" \
  --output table
```

### 배포 프로세스 (자동, 12단계)

스택이 내부적으로 수행하는 순서:

| 단계 | 리소스 | 설명 |
|------|--------|------|
| 1 | VPC, Subnets, SGs | 네트워크 (Public 1 + Private 2 AZ) + NAT GW |
| 2 | Neptune, Valkey, DynamoDB | 데이터 레이어 (VPC 내부) |
| 3 | EC2 (m7g.medium) | ARM64 인스턴스 + SSM 에이전트 등록 |
| 4 | **BuildAllSSMDoc** | EC2에서 git clone → Lambda zip 2개 + Agent zip 2개 빌드 → S3 |
| 5 | Lambda ×2 | S3 zip으로 함수 생성 (travel-tools VPC, trend-collector Public) |
| 6 | AgentCore Gateway | MCP Gateway + 21개 도구 스키마 등록 |
| 7 | AgentCore Runtime ×2 | travel-agent (PUBLIC), trend-collector (PUBLIC) |
| 8 | **FrontendDeploySSMDoc** | Node.js 22 설치 → npm build → systemd 서비스 시작 |
| 9 | CloudFront | HTTPS CDN 배포 |

> 전체 배포 소요 시간: ~25-30분 (Neptune 프로비저닝이 가장 오래 걸림)

### 스택 삭제

```bash
aws cloudformation delete-stack \
  --stack-name ota-travel-md \
  --region ap-northeast-2
```

### 그래프 데이터 적재

Neptune 배포 후, 크롤링 데이터를 그래프에 적재합니다:

```bash
pip install gremlinpython boto3
python scripts/load_graph.py \
  --data-dir ./files/crawled \
  --endpoint wss://<NEPTUNE_ENDPOINT>:8182/gremlin
```

> Neptune 엔드포인트는 스택 Outputs의 `NeptuneEndpoint`에서 확인

### 로컬 개발

```bash
# 에이전트 로컬 서버
make install-agent
cp .env.example .env          # 환경 변수 설정
make agent                    # localhost:8080

# 프론트엔드 로컬 서버
make install-web
make frontend                 # localhost:3000
```

---

## CloudFormation 스택 구성 (55개 리소스)

| 카테고리 | 리소스 수 | 주요 내용 |
|----------|-----------|-----------|
| VPC & Networking | 16 | VPC (10.3.0.0/16), Public + Private ×2, NAT GW |
| Security Groups | 4 | NeptuneSG (self-ref 8182+6379), EC2SG (CF prefix list) |
| IAM | 10 | EC2, AgentCore, Lambda ×2, Gateway, SSM, HealthCheck |
| Data Layer | 5 | Neptune Serverless (2-16 NCU), Valkey Serverless, DynamoDB |
| Compute | 4 | EC2 m7g.medium, Lambda ×2 (arm64), S3 |
| AgentCore | 5 | Gateway, GatewayTarget ×2, Runtime ×2 |
| Orchestration | 6 | SSM Document ×2, Custom Resource Lambda ×3, HealthCheck |
| CDN | 1 | CloudFront (HTTP/2+3) |

### 스택 Outputs

| Output | 설명 |
|--------|------|
| `CloudFrontURL` | 애플리케이션 URL |
| `TravelAgentRuntimeArn` | Travel Agent ARN |
| `TrendCollectorRuntimeArn` | Trend Collector ARN |
| `GatewayUrl` | AgentCore Gateway MCP URL |
| `NeptuneEndpoint` | Neptune 클러스터 엔드포인트 |
| `ValkeyEndpoint` | Valkey 캐시 엔드포인트 |
| `DynamoTableName` | DynamoDB 테이블명 |
| `InstanceId` | EC2 인스턴스 ID |

---

## 캐싱 전략

캐싱은 **Lambda 레벨**에서 Valkey를 통해 수행됩니다. MCP Gateway를 통해 어떤 경로로 호출하든 캐시 혜택을 받습니다.

| TTL | 도구 | 분류 |
|-----|------|------|
| 24h | `get_nearby_cities`, `get_cities_by_country` | 정적 (지리 데이터) |
| 12h | `get_package`, `get_routes_by_region`, `get_attractions_by_city`, `get_hotels_by_city`, `get_similar_packages` | 반정적 |
| 6h | `search_packages` | 동적 (쿼리 의존) |
| 1h | `get_trends` | 휘발 (트렌드 변동) |
| 5min | not found 결과 | 네거티브 캐시 |

쓰기 도구(`upsert_*`, `save_*`, `delete_*`)는 캐시를 bypass하며, `invalidate_cache` 도구로 수동 무효화 가능합니다.

---

## MCP 도구 카탈로그 (21개)

### travel-tools (17개)

| 분류 | 도구 | 설명 |
|------|------|------|
| Graph 읽기 (9) | `get_package`, `search_packages`, `get_routes_by_region`, `get_attractions_by_city`, `get_hotels_by_city`, `get_trends`, `get_similar_packages`, `get_nearby_cities`, `get_cities_by_country` | Neptune Gremlin 조회 + Valkey 캐싱 |
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

---

## 라이선스

이 프로젝트는 내부 프로젝트입니다.
