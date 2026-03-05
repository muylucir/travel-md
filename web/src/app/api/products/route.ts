import { NextRequest, NextResponse } from "next/server";
import { listProducts } from "@/lib/dynamodb";

/**
 * GET /api/products
 * Query DynamoDB directly for AI-planned products.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const region = searchParams.get("region") || undefined;

    const items = await listProducts(limit, region);
    return NextResponse.json({ products: items, count: items.length });
  } catch (error) {
    console.error("[/api/products] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "기획 상품 목록 조회 중 오류가 발생했습니다.",
      },
      { status: 500 }
    );
  }
}
