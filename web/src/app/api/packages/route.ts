import { NextRequest, NextResponse } from "next/server";
import gremlin from "gremlin";
import { getTraversal, mapToObject } from "@/lib/gremlin";
import type { PackageNode } from "@/lib/types";

const __ = gremlin.process.statics;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const desc = (gremlin.process as any).order.desc;

/**
 * GET /api/packages
 * List packages from Neptune via Gremlin.
 *
 * Query params:
 *   destination - filter by region/destination
 *   theme       - filter by theme tag
 *   season      - filter by season
 *   nights      - filter by number of nights
 *   limit       - max results (default 20)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const destination = searchParams.get("destination");
    const theme = searchParams.get("theme");
    const season = searchParams.get("season");
    const nights = searchParams.get("nights");
    const limit = parseInt(searchParams.get("limit") || "100", 10);

    const g = await getTraversal();

    let traversal = g.V().hasLabel("Package");

    if (destination) {
      // Filter packages that visit cities in the given region
      traversal = g
        .V()
        .hasLabel("City")
        .has("region", destination)
        .inE("VISITS")
        .outV()
        .hasLabel("Package")
        .dedup();
    }

    if (theme) {
      traversal = traversal.where(__.out("TAGGED").has("name", theme));
    }

    if (season) {
      traversal = traversal.has("season", season);
    }

    if (nights) {
      traversal = traversal.has("nights", parseInt(nights, 10));
    }

    const results = await traversal
      .order()
      .by("rating", desc)
      .limit(limit)
      .valueMap(true)
      .toList();

    const packages: PackageNode[] = results.map((r: unknown) => {
      const obj = mapToObject<Record<string, unknown>>(r as Map<string, unknown>);
      return normalizePackage(obj);
    });

    return NextResponse.json(packages);
  } catch (error) {
    console.error("[/api/packages] Error:", error);
    return NextResponse.json(
      { error: "패키지 목록 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

function normalizePackage(obj: Record<string, unknown>): PackageNode {
  // Neptune valueMap returns arrays for property values
  const val = (key: string): unknown => {
    const v = obj[key];
    return Array.isArray(v) ? v[0] : v;
  };

  const arrVal = (key: string): string[] => {
    const v = obj[key];
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === "string") {
      try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed : [v];
      } catch {
        return [v];
      }
    }
    return [];
  };

  return {
    code: String(val("code") || ""),
    name: String(val("name") || ""),
    description: val("description") as string | undefined,
    price: Number(val("price")) || 0,
    nights: Number(val("nights")) || 0,
    days: Number(val("days")) || 0,
    rating: Number(val("rating")) || 0,
    review_count: Number(val("review_count")) || 0,
    season: arrVal("season"),
    product_line: val("product_line") as string | undefined,
    hashtags: arrVal("hashtags"),
    shopping_count: Number(val("shopping_count")) || 0,
    has_escort: Boolean(val("has_escort")),
    meal_included: val("meal_included") as string | undefined,
    optional_tour: Boolean(val("optional_tour")),
    source_url: val("source_url") as string | undefined,
  };
}
