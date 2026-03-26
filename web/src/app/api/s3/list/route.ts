import { NextRequest, NextResponse } from "next/server";
import { listS3Objects } from "@/lib/s3-reader";

/**
 * GET /api/s3/list?bucket=X&prefix=Y&delimiter=/
 * S3 버킷의 파일/폴더 목록을 반환한다.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const bucket = searchParams.get("bucket");
  const prefix = searchParams.get("prefix") || "";
  const delimiter = searchParams.get("delimiter") || "/";

  if (!bucket) {
    return NextResponse.json(
      { error: "bucket 파라미터가 필요합니다." },
      { status: 400 }
    );
  }

  try {
    const result = await listS3Objects(bucket, prefix, delimiter);
    return NextResponse.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "S3 목록 조회에 실패했습니다.";

    // AWS SDK 에러 분류
    const code = (err as { name?: string }).name || "";
    if (code === "NoSuchBucket") {
      return NextResponse.json(
        { error: `버킷 "${bucket}"을 찾을 수 없습니다.` },
        { status: 404 }
      );
    }
    if (code === "AccessDenied" || code === "AllAccessDisabled") {
      return NextResponse.json(
        { error: `버킷 "${bucket}"에 대한 접근 권한이 없습니다.` },
        { status: 403 }
      );
    }

    console.error("[/api/s3/list] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
