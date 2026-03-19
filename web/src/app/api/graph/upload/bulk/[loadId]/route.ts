import { NextRequest, NextResponse } from "next/server";
import { getLoadStatus } from "@/lib/neptune-loader";

type Params = { params: Promise<{ loadId: string }> };

/**
 * GET /api/graph/upload/bulk/[loadId]
 * Check Neptune Bulk Loader status.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { loadId } = await params;
    const status = await getLoadStatus(loadId);
    return NextResponse.json(status);
  } catch (error) {
    console.error("[/api/graph/upload/bulk/[loadId]] Error:", error);
    return NextResponse.json(
      {
        error: `상태 조회 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
        status: "ERROR",
      },
      { status: 500 }
    );
  }
}
