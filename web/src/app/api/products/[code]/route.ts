import { NextRequest, NextResponse } from "next/server";
import { getProduct, deleteProductById } from "@/lib/dynamodb";

/**
 * GET /api/products/[code]
 * Query DynamoDB directly for a single product.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    const item = await getProduct(code);

    if (!item) {
      return NextResponse.json(
        { error: `Product ${code} not found` },
        { status: 404 }
      );
    }

    return NextResponse.json(item);
  } catch (error) {
    console.error("[/api/products/code] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "기획 상품 조회 중 오류가 발생했습니다.",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/products/[code]
 * Delete a product directly from DynamoDB.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    await deleteProductById(code);
    return NextResponse.json({ deleted: code });
  } catch (error) {
    console.error("[/api/products/code] DELETE Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "기획 상품 삭제 중 오류가 발생했습니다.",
      },
      { status: 500 }
    );
  }
}
