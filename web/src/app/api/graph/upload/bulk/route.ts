import { NextRequest, NextResponse } from "next/server";
import { convertToNeptuneCsv } from "@/lib/neptune-csv";
import {
  uploadCsvToS3,
  triggerLoad,
  isBulkLoaderAvailable,
} from "@/lib/neptune-loader";

/**
 * POST /api/graph/upload/bulk
 * Convert JSON → Neptune CSV, upload to S3, trigger Bulk Loader.
 *
 * Body: { data, nodeDesign, edgeMappings }
 * Returns: { jobId, loadId, s3Source, stats }
 */
export async function POST(request: NextRequest) {
  try {
    if (!isBulkLoaderAvailable()) {
      return NextResponse.json(
        {
          error:
            "벌크 로더가 설정되지 않았습니다. BULK_LOAD_S3_BUCKET, NEPTUNE_LOAD_IAM_ROLE 환경변수를 확인하세요.",
        },
        { status: 503 }
      );
    }

    const { data, nodeDesign, edgeMappings } = await request.json();

    if (!data || !Array.isArray(data) || data.length === 0) {
      return NextResponse.json(
        { error: "데이터가 비어있습니다." },
        { status: 400 }
      );
    }

    // 1. Convert to Neptune CSV
    const { nodesCsv, edgesCsv, stats } = convertToNeptuneCsv(
      data,
      nodeDesign,
      edgeMappings
    );

    // 2. Upload to S3
    const jobId = `${nodeDesign.nodeLabel.toLowerCase()}-${Date.now().toString(36)}`;
    const s3Source = await uploadCsvToS3(jobId, nodesCsv, edgesCsv);

    // 3. Trigger Neptune Bulk Loader
    const { loadId, status } = await triggerLoad(s3Source);

    return NextResponse.json({
      jobId,
      loadId,
      s3Source,
      status,
      stats,
    });
  } catch (error) {
    console.error("[/api/graph/upload/bulk] Error:", error);
    return NextResponse.json(
      {
        error: `벌크 업로드 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
      },
      { status: 500 }
    );
  }
}
