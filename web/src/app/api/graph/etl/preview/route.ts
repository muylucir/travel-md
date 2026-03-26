import { NextRequest, NextResponse } from "next/server";
import { readS3Json } from "@/lib/s3-reader";
import {
  validateMappingRule,
  convertMappingRule,
  flattenData,
} from "@/lib/mapping-rule";
import { convertToNeptuneCsv } from "@/lib/neptune-csv";

/**
 * POST /api/graph/etl/preview
 * S3 데이터 + 매핑 룰 → dry-run 미리보기.
 *
 * Body: { bucket, key, mappingRule, limit? }
 */
export async function POST(request: NextRequest) {
  try {
    const { bucket, key, mappingRule, limit } = await request.json();

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

    // 2. S3 데이터 샘플 읽기
    const sampleLimit = limit || 200;
    const { data: rawData, totalCount, fields: rawFields } = await readS3Json(
      bucket,
      key,
      sampleLimit
    );

    // 3. 중첩 JSON → 플랫 변환 (dot notation 해석)
    const data = flattenData(rawData, mappingRule);
    const flatFields = data.length > 0 ? Object.keys(data[0]) : rawFields;

    // 4. 매핑 룰 → 내부 타입 변환
    const { nodeDesign, edgeMappings, duplicateStrategy } = convertMappingRule(
      mappingRule,
      flatFields
    );

    // 5. CSV 변환 통계 (dry-run)
    const { stats: csvStats } = convertToNeptuneCsv(
      data,
      nodeDesign,
      edgeMappings
    );

    // 6. 필드 매칭 경고
    const warnings: string[] = [];
    for (const pm of nodeDesign.propertyMappings) {
      if (pm.include && !flatFields.includes(pm.jsonField)) {
        warnings.push(
          `매핑 룰의 필드 "${pm.jsonField}"가 S3 데이터에 없습니다.`
        );
      }
    }
    if (!flatFields.includes(nodeDesign.idField)) {
      warnings.push(
        `ID 필드 "${nodeDesign.idField}"가 S3 데이터에 없습니다.`
      );
    }

    return NextResponse.json({
      data,
      nodeDesign,
      edgeMappings,
      duplicateStrategy,
      fields: flatFields,
      totalCount,
      csvStats,
      warnings,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "미리보기 처리에 실패했습니다.";
    console.error("[/api/graph/etl/preview] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
