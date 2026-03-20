# 그래프 스키마 관리 & 데이터 업로드 — 사용 가이드

> Neptune Graph DB에 다양한 형태의 데이터를 업로드하기 위한 스키마 관리 및 벌크 업로드 기능 사용법입니다.

---

## 전체 흐름

```
1. 스키마 정의 ─────────────────────────── 2. 데이터 업로드
   (한 번만 설정하면 재사용)                     (스키마 선택 후 반복 업로드)

   ┌──────────────────┐                    ┌──────────────────────────────┐
   │  /graph/schemas   │                    │  /graph/upload                │
   │                  │                    │                              │
   │  JSON 가져오기    │───→ 저장 ───→      │  Step 1: 스키마 선택 + 파일   │
   │  또는 폼에서 직접 │                    │  Step 2: 노드 디자인 (확인)   │
   │  노드/엣지 정의   │                    │  Step 3: 엣지 매핑 (확인)     │
   │                  │                    │  Step 4: 미리보기 & 검증       │
   │  Cytoscape 미리보기│                   │  Step 5: 업로드 실행           │
   └──────────────────┘                    └──────────────────────────────┘
```

---

## Part 1: 스키마 관리 (`/graph/schemas`)

### 스키마란?

스키마는 "이 JSON 데이터를 그래프에 어떤 구조로 넣을 것인가"를 정의한 템플릿입니다.

- **노드 정의**: 어떤 라벨로 만들지, 어떤 필드가 ID인지, 어떤 속성이 있는지
- **엣지 정의**: 어떤 JSON 필드가 다른 노드와의 관계를 나타내는지

한 번 정의해 두면 같은 형태의 데이터를 반복 업로드할 때 재사용할 수 있습니다.

---

### 방법 1: JSON 파일로 스키마 등록

가장 빠른 방법입니다. 스키마 정의 JSON 파일을 미리 작성해두고 가져옵니다.

#### 스키마 JSON 형식

```json
{
  "name": "관광지 스키마",
  "description": "관광지 노드 + 도시 연결",
  "nodeLabel": "Attraction",
  "idField": "name",
  "properties": [
    { "name": "name", "type": "string", "required": true },
    { "name": "category", "type": "string", "required": false },
    { "name": "description", "type": "string", "required": false },
    { "name": "family_friendly", "type": "boolean", "required": false }
  ],
  "edges": [
    {
      "sourceField": "city",
      "targetNodeLabel": "City",
      "targetMatchProperty": "name",
      "edgeLabel": "LOCATED_IN",
      "direction": "out",
      "autoCreateTarget": true
    }
  ]
}
```

#### 필드 설명

| 필드 | 설명 | 예시 |
|---|---|---|
| `name` | 스키마 표시 이름 | "관광지 스키마" |
| `description` | 설명 (선택) | "관광지 노드 + 도시 연결" |
| `nodeLabel` | 생성할 노드 타입 | "Attraction", "Hotel", "Restaurant" |
| `idField` | JSON에서 고유 식별자로 사용할 필드명 | "name", "code", "id" |
| `properties` | 노드에 저장할 속성 목록 | 아래 참조 |
| `edges` | 다른 노드와의 관계 규칙 | 아래 참조 |

**속성 (properties)**:

| 필드 | 설명 | 값 |
|---|---|---|
| `name` | JSON 필드명 = 노드 속성명 | "name", "price" |
| `type` | 데이터 타입 | "string", "number", "boolean", "json" |
| `required` | 필수 여부 | true / false |

**엣지 (edges)**:

| 필드 | 설명 | 예시 |
|---|---|---|
| `sourceField` | 관계 값이 들어있는 JSON 필드 | "city", "country" |
| `targetNodeLabel` | 연결 대상 노드 타입 | "City", "Country" |
| `targetMatchProperty` | 대상 노드에서 값을 매칭할 속성 | "name" |
| `edgeLabel` | 엣지 라벨 | "LOCATED_IN", "IN_COUNTRY" |
| `direction` | 엣지 방향 | "out" (현재→대상), "in" (대상→현재) |
| `autoCreateTarget` | 대상 노드가 없을 때 자동 생성 | true / false |

#### 등록 순서

1. `/graph/schemas` 페이지 접속
2. **"스키마 생성"** 클릭
3. **"JSON에서 가져오기"** 버튼 클릭 → `.schema.json` 파일 선택
4. 폼에 자동 반영 → 내용 확인/수정
5. **"스키마 생성"** 버튼 클릭 → DynamoDB에 저장

---

### 방법 2: 폼에서 직접 정의

1. `/graph/schemas` 페이지 접속
2. **"스키마 생성"** 클릭
3. 기본 정보 입력 (이름, 설명)
4. 노드 정의:
   - **노드 라벨**: 드롭다운에서 기존 타입 선택 또는 "새 타입 직접 입력"
   - **ID 필드**: 데이터에서 고유 식별자로 쓸 필드명 입력
5. 속성 정의: **"속성 추가"** 버튼으로 속성을 하나씩 추가 (이름, 타입, 필수 여부)
6. 엣지 정의: **"엣지 추가"** 버튼으로 관계 규칙 추가
7. 하단 **스키마 미리보기**에서 Cytoscape 그래프로 구조 확인
8. **"스키마 생성"** 클릭

---

### 스키마 내보내기

정의한 스키마를 JSON 파일로 다운로드하여 다른 환경에서 재사용할 수 있습니다.

1. 스키마 편집 화면에서 **"JSON으로 내보내기"** 클릭
2. `{NodeLabel}.schema.json` 파일이 다운로드됨

---

### 스키마 예시 모음

#### 호텔 스키마

```json
{
  "name": "호텔",
  "nodeLabel": "Hotel",
  "idField": "name_en",
  "properties": [
    { "name": "name_ko", "type": "string", "required": true },
    { "name": "name_en", "type": "string", "required": true },
    { "name": "grade", "type": "string", "required": false },
    { "name": "room_type", "type": "string", "required": false },
    { "name": "amenities", "type": "string", "required": false },
    { "name": "has_onsen", "type": "boolean", "required": false }
  ],
  "edges": [
    {
      "sourceField": "city",
      "targetNodeLabel": "City",
      "targetMatchProperty": "name",
      "edgeLabel": "LOCATED_IN",
      "direction": "out",
      "autoCreateTarget": true
    }
  ]
}
```

#### 패키지 스키마

```json
{
  "name": "여행 패키지",
  "nodeLabel": "Package",
  "idField": "code",
  "properties": [
    { "name": "code", "type": "string", "required": true },
    { "name": "name", "type": "string", "required": true },
    { "name": "price", "type": "number", "required": false },
    { "name": "nights", "type": "number", "required": false },
    { "name": "days", "type": "number", "required": false },
    { "name": "rating", "type": "number", "required": false },
    { "name": "hashtags", "type": "json", "required": false },
    { "name": "season", "type": "json", "required": false }
  ],
  "edges": [
    {
      "sourceField": "region",
      "targetNodeLabel": "Region",
      "targetMatchProperty": "name",
      "edgeLabel": "IN_REGION",
      "direction": "out",
      "autoCreateTarget": true
    },
    {
      "sourceField": "country",
      "targetNodeLabel": "Country",
      "targetMatchProperty": "name",
      "edgeLabel": "IN_COUNTRY",
      "direction": "out",
      "autoCreateTarget": true
    }
  ]
}
```

#### 트렌드 스키마

```json
{
  "name": "트렌드",
  "nodeLabel": "Trend",
  "idField": "title",
  "properties": [
    { "name": "title", "type": "string", "required": true },
    { "name": "type", "type": "string", "required": true },
    { "name": "source", "type": "string", "required": true },
    { "name": "date", "type": "string", "required": true },
    { "name": "virality_score", "type": "number", "required": true },
    { "name": "decay_rate", "type": "number", "required": false },
    { "name": "keywords", "type": "json", "required": false },
    { "name": "tier", "type": "string", "required": false }
  ],
  "edges": [
    {
      "sourceField": "city",
      "targetNodeLabel": "City",
      "targetMatchProperty": "name",
      "edgeLabel": "MENTIONS",
      "direction": "out",
      "autoCreateTarget": false
    }
  ]
}
```

---

## Part 2: 데이터 업로드 (`/graph/upload`)

### Step 1: 스키마 선택 + 파일 업로드

1. **스키마 선택** (상단 드롭다운)
   - 등록된 스키마 중 하나를 선택하면 노드/엣지 설정이 자동으로 채워집니다
   - "스키마 없이 수동 설정"을 선택하면 Step 2~3에서 직접 설정
   - "스키마 관리" 링크로 새 스키마 생성 가능

2. **JSON 파일 업로드**
   - 드래그 앤 드롭 또는 클릭하여 파일 선택
   - 플랫 JSON 배열 형식: `[{...}, {...}, ...]`
   - 파일 로드 후 레코드 수, 감지된 필드, 데이터 미리보기 표시

### Step 2: 노드 디자인

스키마를 선택했다면 이미 채워져 있습니다. 확인만 하면 됩니다.

- **노드 라벨**: 생성할 노드의 타입 (예: Attraction, Hotel)
- **ID 필드**: 각 노드를 고유하게 식별할 필드
- **속성 매핑**: JSON 필드 → 노드 속성 대응. 불필요한 필드는 토글 OFF

### Step 3: 엣지 매핑 (선택)

스키마를 선택했다면 이미 채워져 있습니다.

- 스키마 없이 수동 설정 시 **"자동 추천"** 버튼으로 알려진 패턴(city→City, country→Country 등)을 자동 추천
- **"규칙 추가"** 버튼으로 커스텀 엣지 규칙 추가 가능

### Step 4: 미리보기 & 검증

4개 탭으로 업로드 전 데이터를 검증합니다.

| 탭 | 내용 |
|---|---|
| **데이터 테이블** | 생성될 노드 목록 (Vertex ID, 속성 값) |
| **그래프 미리보기** | Cytoscape로 노드/엣지 시각화 (상위 50건) |
| **중복 검사** | Neptune에 이미 존재하는 노드 확인 + 처리 방법 선택 (건너뛰기/업데이트/새로 생성) |
| **통계 요약** | 총 레코드, 노드/엣지 타입별 분포 |

### Step 5: 업로드 실행

**"업로드 실행"** 버튼을 클릭하면:

- **500건 이하**: Gremlin 순차 방식 (실시간 중복 처리)
- **500건 초과**: Neptune Bulk Loader 자동 전환 (JSON → CSV → S3 → Neptune Loader API)

업로드 완료 후 결과 요약:

- 생성/업데이트/건너뛴 노드 수
- 생성된 엣지 수
- 자동 생성된 대상 노드 수
- 소요 시간
- 오류 목록 (있는 경우)

---

## 데이터 파일 준비 팁

### 올바른 형식

```json
[
  {
    "name": "오사카성",
    "category": "관광지",
    "city": "오사카",
    "description": "일본 3대 성"
  },
  {
    "name": "도톤보리",
    "category": "쇼핑",
    "city": "오사카",
    "description": "먹거리 거리"
  }
]
```

### 주의 사항

- **최상위는 반드시 배열** `[...]` 형태여야 합니다
- 모든 객체가 **동일한 필드 구조**를 가져야 합니다
- **ID 필드의 값은 고유**해야 합니다 (중복 시 처리 전략에 따라 동작)
- 중첩 객체/배열은 `json` 타입으로 문자열 직렬화되어 저장됩니다
- 배열 값의 엣지 필드는 각 요소마다 개별 엣지가 생성됩니다

### 대용량 데이터 업로드 시

- 500건 초과 시 자동으로 Neptune Bulk Loader 사용
- Bulk Loader는 S3를 경유하므로 네트워크 타임아웃 걱정 없음
- 10,000건 기준 약 10~30초 소요 (Gremlin 순차 대비 10배 이상 빠름)
- CSV 파일은 S3에 7일간 보관 후 자동 삭제

---

## FAQ

### Q: 같은 스키마로 다른 데이터를 여러 번 업로드할 수 있나요?

네. 스키마는 한 번 정의하면 재사용됩니다. 업로드 Wizard에서 같은 스키마를 선택하고 다른 JSON 파일을 올리면 됩니다.

### Q: 이미 있는 노드와 겹치면 어떻게 되나요?

Step 4 "중복 검사" 탭에서 세 가지 처리 방법을 선택할 수 있습니다:
- **건너뛰기**: 기존 노드는 그대로, 새 노드만 생성
- **업데이트**: 기존 노드의 속성을 새 데이터로 덮어쓰기
- **새로 생성**: 중복 여부와 관계없이 모두 새로 생성 (ID 충돌 가능)

### Q: 엣지의 대상 노드(예: City)가 그래프에 없으면?

엣지 규칙에서 **"대상 노드 없으면 자동 생성"**이 켜져 있으면 (기본값 ON), 해당 값으로 새 노드를 자동 생성한 후 엣지를 연결합니다.

### Q: 벌크 로더가 실패하면 데이터가 일부만 들어가나요?

Neptune Bulk Loader는 `failOnError: FALSE`로 설정되어 있어, 오류가 있는 행만 건너뛰고 나머지는 정상 로드됩니다. 결과 화면에서 오류 목록을 확인할 수 있습니다.

### Q: 커스텀 노드 타입을 만들 수 있나요?

네. 스키마 정의 시 노드 라벨에서 "새 타입 직접 입력"을 선택하면 `Restaurant`, `Museum` 등 원하는 타입을 자유롭게 만들 수 있습니다. Neptune은 Schema-free이므로 제한이 없습니다.

---

## Part 3: 그래프 탐색기 (`/graph`)

### 초기 로딩 방식

그래프 탐색기는 성능을 위해 **Stats-first** 방식으로 동작합니다.

1. 페이지 접속 시 **통계 카드**가 즉시 표시됩니다 (총 노드/엣지 수, 타입 수)
2. 그래프 시각화 영역에는 **상위 200개 노드**만 로드됩니다
3. 필요한 경우 **"전체 로드"** 버튼으로 모든 노드를 불러올 수 있습니다

```
┌─────────────────────────────────────────────────┐
│  총 노드: 5,230 │ 총 엣지: 12,450 │ 노드 타입: 12 │ 엣지 타입: 16  │
└─────────────────────────────────────────────────┘

  노드 200 / 5,230개 / 엣지 380개 (상위 200개 노드만 표시 중)

  [타입 필터]  [레이아웃 선택]  [전체 로드]  [새로고침]
```

- **타입 필터**: 특정 노드 타입만 필터링하여 표시
- **레이아웃 선택**: Force-Directed, 동심원, 계층형, 원형, 그리드
- **노드 클릭**: 사이드 패널에서 상세 정보 확인 + "이웃 확장"으로 연결된 노드 추가 로드
- **새로고침**: 캐시를 무시하고 최신 데이터로 갱신

### 캐싱

그래프 데이터는 2-tier 캐시로 관리됩니다.

| 계층 | 저장소 | TTL | 특징 |
|---|---|---|---|
| L1 | 서버 인메모리 | 1시간 | 가장 빠름, 프로세스 재시작 시 초기화 |
| L2 | Valkey (ElastiCache) | 1시간 | 프로세스 간 공유, 서버 재시작에도 유지 |

- 첫 번째 요청: Neptune 쿼리 → L1 + L2에 캐싱
- 이후 요청: L1 히트 시 즉시 반환 (1ms 미만)
- 그래프 초기화 또는 업로드 후 캐시가 자동 무효화됩니다

### 그래프 전체 삭제 (초기화)

Neptune Graph DB의 **모든 노드와 엣지를 영구 삭제**하는 기능입니다.

1. 그래프 탐색기 우측 상단 **"그래프 초기화"** 버튼 클릭
2. 확인 모달에서 현재 그래프 규모 확인 (노드 N개, 엣지 M개)
3. 입력란에 **"삭제"** 텍스트 입력 (이중 확인)
4. **"전체 삭제"** 버튼 클릭
5. 삭제 완료 후 결과 표시 (삭제된 노드/엣지 수)

**주의**: 이 작업은 되돌릴 수 없습니다. 삭제 후 관련 캐시(graph, packages, trends)가 모두 무효화됩니다.
