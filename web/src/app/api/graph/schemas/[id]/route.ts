import { NextRequest, NextResponse } from "next/server";
import { getSchema, putSchema, deleteSchema } from "@/lib/schema-db";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/graph/schemas/[id]
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const schema = await getSchema(id);
    if (!schema) {
      return NextResponse.json(
        { error: "스키마를 찾을 수 없습니다." },
        { status: 404 }
      );
    }
    return NextResponse.json(schema);
  } catch (error) {
    console.error("[/api/graph/schemas/[id]] GET Error:", error);
    return NextResponse.json(
      { error: "스키마 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/graph/schemas/[id]
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const existing = await getSchema(id);
    if (!existing) {
      return NextResponse.json(
        { error: "스키마를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    const body = await request.json();
    const updated = {
      ...existing,
      ...body,
      schemaId: id, // prevent ID change
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    await putSchema(updated);
    return NextResponse.json(updated);
  } catch (error) {
    console.error("[/api/graph/schemas/[id]] PUT Error:", error);
    return NextResponse.json(
      { error: "스키마 수정 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/graph/schemas/[id]
 */
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    await deleteSchema(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[/api/graph/schemas/[id]] DELETE Error:", error);
    return NextResponse.json(
      { error: "스키마 삭제 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
