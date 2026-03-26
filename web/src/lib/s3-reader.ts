/**
 * S3 읽기 유틸리티 (서버사이드 전용).
 *
 * ListObjectsV2 + GetObject 로 S3 JSON 데이터를 읽어온다.
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION || "ap-northeast-2";

function getS3Client(): S3Client {
  return new S3Client({ region: REGION });
}

// ─── S3 객체 목록 조회 ───

export interface S3ObjectInfo {
  key: string;
  size: number;
  lastModified: string;
}

export async function listS3Objects(
  bucket: string,
  prefix: string = "",
  delimiter: string = "/"
): Promise<{ prefixes: string[]; objects: S3ObjectInfo[] }> {
  const s3 = getS3Client();
  const prefixes: string[] = [];
  const objects: S3ObjectInfo[] = [];
  let continuationToken: string | undefined;

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: delimiter,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      })
    );

    // 폴더 (CommonPrefixes)
    for (const cp of res.CommonPrefixes || []) {
      if (cp.Prefix) prefixes.push(cp.Prefix);
    }

    // 파일 (Contents) — 디렉토리 마커 제외
    for (const obj of res.Contents || []) {
      if (!obj.Key || obj.Key === prefix) continue;
      objects.push({
        key: obj.Key,
        size: obj.Size || 0,
        lastModified: obj.LastModified?.toISOString() || "",
      });
    }

    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  // 최근 수정순 정렬
  objects.sort(
    (a, b) =>
      new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
  );

  return { prefixes, objects };
}

// ─── S3 JSON 데이터 읽기 ───

export async function readS3Json(
  bucket: string,
  key: string,
  limit?: number
): Promise<{
  data: Record<string, unknown>[];
  totalCount: number;
  fields: string[];
}> {
  const s3 = getS3Client();
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );

  if (!res.Body) {
    throw new Error("S3 객체 본문이 비어있습니다.");
  }

  const text = await res.Body.transformToString("utf-8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "S3 데이터가 유효한 JSON이 아닙니다. UTF-8 JSON 파일인지 확인하세요."
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      "S3 데이터가 JSON 배열이 아닙니다. 최상위가 [...] 형태여야 합니다."
    );
  }

  if (parsed.length === 0) {
    throw new Error("S3 데이터가 빈 배열입니다.");
  }

  const totalCount = parsed.length;
  const data = limit ? parsed.slice(0, limit) : parsed;

  // 첫 레코드에서 필드명 추출
  const fields = Object.keys(parsed[0] as Record<string, unknown>);

  return { data, totalCount, fields };
}
