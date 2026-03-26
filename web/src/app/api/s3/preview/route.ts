import { NextRequest, NextResponse } from "next/server";
import { readS3Json } from "@/lib/s3-reader";

/**
 * GET /api/s3/preview?bucket=X&key=Y&limit=100
 * S3 JSON 파일의 샘플 데이터 + 필드 목록을 반환한다.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const bucket = searchParams.get("bucket");
  const key = searchParams.get("key");
  const limit = parseInt(searchParams.get("limit") || "100", 10);

  if (!bucket || !key) {
    return NextResponse.json(
      { error: "bucket, key 파라미터가 필요합니다." },
      { status: 400 }
    );
  }

  try {
    const result = await readS3Json(bucket, key, limit);
    return NextResponse.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "S3 데이터 읽기에 실패했습니다.";

    const code = (err as { name?: string }).name || "";
    if (code === "NoSuchKey") {
      return NextResponse.json(
        { error: `S3 객체 "${key}"를 찾을 수 없습니다.` },
        { status: 404 }
      );
    }
    if (code === "AccessDenied") {
      return NextResponse.json(
        { error: "S3 객체에 대한 접근 권한이 없습니다." },
        { status: 403 }
      );
    }

    console.error("[/api/s3/preview] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
