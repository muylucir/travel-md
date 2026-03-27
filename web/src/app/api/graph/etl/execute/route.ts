import { NextRequest, NextResponse } from "next/server";
import { readS3Json } from "@/lib/s3-reader";
import { validateMappingRule, convertMappingRule, flattenData } from "@/lib/mapping-rule";
import { convertToNeptuneCsv } from "@/lib/neptune-csv";
import {
  uploadCsvToS3,
  triggerLoad,
  isBulkLoaderAvailable,
} from "@/lib/neptune-loader";
import { executeQuery } from "@/lib/neptune";

const DELETE_BATCH = 500;
const DEFAULT_BATCH_SIZE = 100;

/**
 * 특정 label의 vertex와 연결된 edge를 모두 삭제한다.
 * Label은 Cypher에서 파라미터화할 수 없으므로 직접 삽입 (검증 필수).
 */
async function dropVerticesByLabel(label: string): Promise<{
  deletedVertices: number;
  deletedEdges: number;
}> {
  // Validate label to prevent injection
  if (!/^[A-Za-z0-9_]+$/.test(label)) {
    throw new Error(`Invalid label: ${label}`);
  }

  // Count before deletion
  const [vCountRow] = await executeQuery<{ cnt: number }>(
    `MATCH (n:${label}) RETURN count(n) AS cnt`
  );
  const vCount = Number(vCountRow?.cnt ?? 0);

  // Delete edges connected to vertices of this label
  let hasMore = true;
  let deletedEdges = 0;
  while (hasMore) {
    const [countRow] = await executeQuery<{ cnt: number }>(
      `MATCH (n:${label})-[r]-() RETURN count(r) AS cnt`
    );
    const count = Number(countRow?.cnt ?? 0);
    if (count === 0) {
      hasMore = false;
    } else {
      await executeQuery(
        `MATCH (n:${label})-[r]-() WITH r LIMIT ${DELETE_BATCH} DELETE r`
      );
      deletedEdges += Math.min(count, DELETE_BATCH);
    }
  }

  // Delete vertices
  hasMore = true;
  while (hasMore) {
    const [countRow] = await executeQuery<{ cnt: number }>(
      `MATCH (n:${label}) RETURN count(n) AS cnt`
    );
    const count = Number(countRow?.cnt ?? 0);
    if (count === 0) {
      hasMore = false;
    } else {
      await executeQuery(
        `MATCH (n:${label}) WITH n LIMIT ${DELETE_BATCH} DETACH DELETE n`
      );
    }
  }

  return { deletedVertices: vCount, deletedEdges };
}

/**
 * POST /api/graph/etl/execute
 * S3 데이터 + 매핑 룰 → 기존 그래프 삭제 후 Neptune 적재.
 *
 * Body: { bucket, key, mappingRule }
 *
 * 동작:
 *   1. 해당 label의 기존 vertex + edge 삭제
 *   2. 100건 이상: Bulk Loader / 미만: OpenCypher 순차 적재
 */
export async function POST(request: NextRequest) {
  try {
    const { bucket, key, mappingRule } = await request.json();

    if (!bucket || !key) {
      return NextResponse.json(
        { error: "bucket, key 파라미터가 필요합니다." },
        { status: 400 }
      );
    }

    // 1. 매핑 룰 검증
    const validation = validateMappingRule(mappingRule);
    if (!validation.valid) {
      return NextResponse.json(
        { error: "매핑 룰 검증 실패", details: validation.errors },
        { status: 400 }
      );
    }

    // 2. S3 전체 데이터 읽기 + 중첩 JSON 플랫 변환
    const { data: rawData, totalCount, fields: rawFields } = await readS3Json(bucket, key);
    const data = flattenData(rawData, mappingRule);
    const flatFields = data.length > 0 ? Object.keys(data[0]) : rawFields;

    // 3. 매핑 룰 → 내부 타입 변환
    const { nodeDesign, edgeMappings, duplicateStrategy } = convertMappingRule(
      mappingRule,
      flatFields
    );

    // 4. 기존 그래프 삭제 (해당 label)
    const deleteResult = await dropVerticesByLabel(nodeDesign.nodeLabel);

    const batchSize = mappingRule.options?.batch_size ?? DEFAULT_BATCH_SIZE;
    const useBulk = data.length >= batchSize;

    // 5. 적재 경로 분기
    if (useBulk) {
      // ── Bulk Loader 경로 ──
      if (!isBulkLoaderAvailable()) {
        return NextResponse.json(
          {
            error:
              "벌크 로더가 설정되지 않았습니다. BULK_LOAD_S3_BUCKET, NEPTUNE_LOAD_IAM_ROLE 환경변수를 확인하세요.",
          },
          { status: 503 }
        );
      }

      const { nodesCsv, edgesCsv, stats } = convertToNeptuneCsv(
        data,
        nodeDesign,
        edgeMappings
      );

      const jobId = `etl-${nodeDesign.nodeLabel.toLowerCase()}-${Date.now().toString(36)}`;
      const s3Source = await uploadCsvToS3(jobId, nodesCsv, edgesCsv);
      const { loadId, status } = await triggerLoad(s3Source);

      return NextResponse.json({
        mode: "bulk",
        jobId,
        loadId,
        s3Source,
        status,
        stats,
        totalCount,
        deleteResult,
      });
    } else {
      // ── OpenCypher 순차 적재 경로 ──
      const uploadUrl = new URL("/api/graph/upload", request.url);
      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data,
          nodeDesign,
          edgeMappings,
          duplicateStrategy,
        }),
      });

      const uploadResult = await uploadRes.json();

      return NextResponse.json({
        mode: "opencypher",
        ...uploadResult,
        totalCount,
        deleteResult,
      });
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "적재 처리에 실패했습니다.";
    console.error("[/api/graph/etl/execute] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
