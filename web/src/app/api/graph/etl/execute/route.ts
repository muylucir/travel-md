import { NextRequest, NextResponse } from "next/server";
import { readS3Json } from "@/lib/s3-reader";
import { validateMappingRule, convertMappingRule, flattenData } from "@/lib/mapping-rule";
import { convertToNeptuneCsv } from "@/lib/neptune-csv";
import {
  uploadCsvToS3,
  triggerLoad,
  isBulkLoaderAvailable,
} from "@/lib/neptune-loader";
import { getTraversal } from "@/lib/gremlin";

const DELETE_BATCH = 500;
const DEFAULT_BATCH_SIZE = 100;

/**
 * 특정 label의 vertex와 연결된 edge를 모두 삭제한다.
 * Neptune은 iterate()를 지원하지 않으므로 batch loop로 처리.
 */
async function dropVerticesByLabel(label: string): Promise<{
  deletedVertices: number;
  deletedEdges: number;
}> {
  const g = await getTraversal();

  // 삭제 전 카운트
  const vCount = Number((await g.V().hasLabel(label).count().next()).value);

  // 해당 label vertex에 연결된 edge 삭제
  let hasMore = true;
  let deletedEdges = 0;
  while (hasMore) {
    const edges = await g
      .V()
      .hasLabel(label)
      .bothE()
      .limit(DELETE_BATCH)
      .count()
      .next();
    const count = Number(edges.value);
    if (count === 0) {
      hasMore = false;
    } else {
      await g
        .V()
        .hasLabel(label)
        .bothE()
        .limit(DELETE_BATCH)
        .drop()
        .fold()
        .next();
      deletedEdges += count;
    }
  }

  // vertex 삭제
  hasMore = true;
  while (hasMore) {
    const verts = await g
      .V()
      .hasLabel(label)
      .limit(DELETE_BATCH)
      .count()
      .next();
    const count = Number(verts.value);
    if (count === 0) {
      hasMore = false;
    } else {
      await g
        .V()
        .hasLabel(label)
        .limit(DELETE_BATCH)
        .drop()
        .fold()
        .next();
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
 *   2. 100건 이상: Bulk Loader / 미만: Gremlin 순차 적재
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
      // ── Gremlin 순차 적재 경로 ──
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
        mode: "gremlin",
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
