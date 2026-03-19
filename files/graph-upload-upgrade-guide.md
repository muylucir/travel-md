# 그래프 업로드 기능 — 기존 배포 환경 업그레이드 가이드

> 기존에 `travel-md-standalone-stack.yaml`로 배포한 환경에서 프론트엔드만 새로 배포할 때 필요한 추가 작업입니다.

---

## 1. 사전 조건

- 기존 CFN 스택이 정상 동작 중 (Neptune, DynamoDB, EC2, CloudFront)
- EC2 인스턴스에 SSH 또는 SSM Session Manager 접근 가능
- AWS CLI가 EC2 인스턴스 IAM Role 권한으로 실행 가능

---

## 2. DynamoDB 테이블 생성

그래프 스키마 템플릿을 저장할 DynamoDB 테이블을 생성합니다.

```bash
aws dynamodb create-table \
  --table-name graph-schemas \
  --attribute-definitions AttributeName=schemaId,AttributeType=S \
  --key-schema AttributeName=schemaId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ap-northeast-2
```

> **참고**: CFN 스택을 업데이트하는 경우 `GraphSchemasTable` 리소스가 자동 생성되므로 이 단계는 건너뛸 수 있습니다.

테이블 생성 확인:

```bash
aws dynamodb describe-table --table-name graph-schemas --query "Table.TableStatus" --region ap-northeast-2
# "ACTIVE" 출력되면 성공
```

---

## 3. Neptune Bulk Loader용 S3 버킷 생성

대용량 데이터 벌크 업로드를 위한 S3 버킷을 생성합니다.

```bash
# 버킷 이름은 고유해야 합니다 (예: travel-md-bulk-{account-id})
BUCKET_NAME="travel-md-bulk-$(aws sts get-caller-identity --query Account --output text)"

aws s3 mb s3://${BUCKET_NAME} --region ap-northeast-2

# 7일 자동 삭제 lifecycle 설정 (선택)
aws s3api put-bucket-lifecycle-configuration \
  --bucket ${BUCKET_NAME} \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "CleanupOldUploads",
      "Status": "Enabled",
      "Filter": {"Prefix": "graph-upload/"},
      "Expiration": {"Days": 7}
    }]
  }'
```

---

## 4. Neptune Bulk Loader IAM Role 생성

Neptune이 S3에서 CSV를 읽을 수 있도록 IAM Role을 생성하고 Neptune 클러스터에 연결합니다.

### 4-1. IAM Role 생성

```bash
# Trust Policy 생성
cat > /tmp/neptune-s3-trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "rds.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOF

# Role 생성
aws iam create-role \
  --role-name neptune-bulk-load-s3-role \
  --assume-role-policy-document file:///tmp/neptune-s3-trust.json

# S3 읽기 권한 부여
cat > /tmp/neptune-s3-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::${BUCKET_NAME}",
      "arn:aws:s3:::${BUCKET_NAME}/*"
    ]
  }]
}
EOF

aws iam put-role-policy \
  --role-name neptune-bulk-load-s3-role \
  --policy-name NeptuneS3Read \
  --policy-document file:///tmp/neptune-s3-policy.json
```

### 4-2. Neptune 클러스터에 Role 연결

```bash
NEPTUNE_CLUSTER_ID="travel-md-neptune"  # 실제 클러스터 ID로 변경
ROLE_ARN=$(aws iam get-role --role-name neptune-bulk-load-s3-role --query "Role.Arn" --output text)

aws neptune add-role-to-db-cluster \
  --db-cluster-identifier ${NEPTUNE_CLUSTER_ID} \
  --role-arn ${ROLE_ARN} \
  --region ap-northeast-2
```

연결 확인 (Available 상태가 될 때까지 1~2분 소요):

```bash
aws neptune describe-db-clusters \
  --db-cluster-identifier ${NEPTUNE_CLUSTER_ID} \
  --query "DBClusters[0].AssociatedRoles" \
  --region ap-northeast-2
```

---

## 5. EC2 IAM Role 권한 추가

EC2 인스턴스의 IAM Role에 새 리소스 접근 권한을 추가합니다.

```bash
EC2_ROLE_NAME="travel-md-ec2-role"  # 실제 Role 이름으로 변경

# S3 Bulk Load 버킷 권한
cat > /tmp/ec2-bulk-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BulkLoadS3",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::${BUCKET_NAME}",
        "arn:aws:s3:::${BUCKET_NAME}/*"
      ]
    },
    {
      "Sid": "GraphSchemasTable",
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Scan",
        "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:Query"
      ],
      "Resource": "arn:aws:dynamodb:ap-northeast-2:*:table/graph-schemas"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name ${EC2_ROLE_NAME} \
  --policy-name GraphUploadPolicy \
  --policy-document file:///tmp/ec2-bulk-policy.json
```

---

## 6. 프론트엔드 환경변수 추가

EC2에서 프론트엔드 `.env.local` 파일에 새 환경변수를 추가합니다.

```bash
ROLE_ARN=$(aws iam get-role --role-name neptune-bulk-load-s3-role --query "Role.Arn" --output text)

cat >> /opt/travel-md-web/.env.local << EOF
SCHEMA_TABLE_NAME=graph-schemas
BULK_LOAD_S3_BUCKET=${BUCKET_NAME}
NEPTUNE_LOAD_IAM_ROLE=${ROLE_ARN}
EOF
```

---

## 7. 프론트엔드 재배포

```bash
# 최신 소스 가져오기
cd /tmp/travel-md-build/web
git pull origin main

# 빌드 및 배포
npm ci
npm run build

# standalone 복사
rm -rf /opt/travel-md-web/.next
cp -r .next/standalone/. /opt/travel-md-web/
cp -r .next/static /opt/travel-md-web/.next/static
cp -r public /opt/travel-md-web/public 2>/dev/null || true

# 서비스 재시작
sudo systemctl restart travel-md-web
```

헬스 체크:

```bash
curl -sf http://localhost:3000 > /dev/null && echo "OK" || echo "FAIL"
```

---

## 8. 확인 사항

| 항목 | 확인 방법 |
|---|---|
| 스키마 관리 페이지 | 브라우저에서 `/graph/schemas` 접속 |
| 그래프 업로드 페이지 | 브라우저에서 `/graph/upload` 접속 |
| DynamoDB 테이블 | 스키마 생성/조회가 정상 동작하는지 확인 |
| 벌크 로더 (500건 초과) | 500건 이상 데이터 업로드 시 "Neptune Bulk Loader 사용 중" 메시지 확인 |

---

## 문제 해결

### 스키마 페이지에서 "스키마 목록을 불러올 수 없습니다" 오류

- `SCHEMA_TABLE_NAME` 환경변수 확인
- DynamoDB `graph-schemas` 테이블 존재 여부 확인
- EC2 IAM Role에 DynamoDB 권한 확인

### 벌크 업로드 시 "BULK_LOAD_S3_BUCKET 환경변수가 설정되지 않았습니다" 오류

- `.env.local`에 `BULK_LOAD_S3_BUCKET` 설정 확인
- 서비스 재시작 필요: `sudo systemctl restart travel-md-web`

### Neptune Bulk Loader "Access Denied" 오류

- Neptune 클러스터에 IAM Role이 연결되었는지 확인 (4-2 단계)
- Role의 S3 버킷 ARN이 정확한지 확인
- Role 연결 후 "Available" 상태가 될 때까지 대기 (1~2분)

### 500건 이하인데 벌크 로더를 사용하고 싶은 경우

현재 자동 전환 임계값은 500건입니다. 변경하려면 `web/src/components/graph-upload/UploadWizard.tsx`의 `BULK_THRESHOLD` 값을 수정하세요.
