import { NextRequest, NextResponse } from "next/server";
import { listSchemas, putSchema } from "@/lib/schema-db";

/**
 * GET /api/graph/schemas
 * List all saved graph schemas.
 */
export async function GET() {
  try {
    const schemas = await listSchemas();
    // Sort by updatedAt descending
    schemas.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    return NextResponse.json(schemas);
  } catch (error) {
    console.error("[/api/graph/schemas] GET Error:", error);
    return NextResponse.json(
      { error: "스키마 목록 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

/**
 * POST /api/graph/schemas
 * Create a new graph schema.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      name,
      description,
      nodeLabel,
      idField,
      properties,
      edges,
    } = body;

    if (!name || !nodeLabel || !idField) {
      return NextResponse.json(
        { error: "name, nodeLabel, idField는 필수입니다." },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    const schemaId = `${nodeLabel.toLowerCase()}-${Date.now().toString(36)}`;

    const schema = {
      schemaId,
      name,
      description: description || "",
      nodeLabel,
      idField,
      properties: properties || [],
      edges: edges || [],
      createdAt: now,
      updatedAt: now,
    };

    await putSchema(schema);
    return NextResponse.json(schema, { status: 201 });
  } catch (error) {
    console.error("[/api/graph/schemas] POST Error:", error);
    return NextResponse.json(
      { error: "스키마 생성 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
