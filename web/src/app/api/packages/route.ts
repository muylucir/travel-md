import { NextRequest, NextResponse } from "next/server";
import { executeQuery, extractNode } from "@/lib/neptune";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";
import type { PackageNode } from "@/lib/types";

/**
 * GET /api/packages
 * List packages from Neptune via OpenCypher.
 *
 * Query params:
 *   destination - filter by region/destination
 *   theme       - filter by theme tag
 *   season      - filter by season
 *   nights      - filter by number of nights
 *   limit       - max results (default 100)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const destination = searchParams.get("destination");
  const theme = searchParams.get("theme");
  const season = searchParams.get("season");
  const nights = searchParams.get("nights");
  const limit = parseInt(searchParams.get("limit") || "100", 10);

  const cacheKey = `packages:${destination || ""}:${theme || ""}:${season || ""}:${nights || ""}:${limit}`;
  const cached = cacheGet<PackageNode[]>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const matchParts = ["MATCH (p:Package)"];
    const whereParts: string[] = [];
    const params: Record<string, unknown> = {};

    if (destination) {
      matchParts[0] = "MATCH (p:Package)-[:VISITS]->(c:City)";
      whereParts.push("(c.name = $dest OR c.region = $dest OR c.country = $dest)");
      params.dest = destination;
    }

    if (theme) {
      matchParts.push("MATCH (p)-[:TAGGED]->(th:Theme {name: $theme})");
      params.theme = theme;
    }

    if (season) {
      whereParts.push("p.season CONTAINS $season");
      params.season = season;
    }

    if (nights) {
      whereParts.push("p.nights = $nights");
      params.nights = parseInt(nights, 10);
    }

    let query = matchParts.join("\n");
    if (whereParts.length > 0) {
      query += "\nWHERE " + whereParts.join(" AND ");
    }
    query += `\nRETURN DISTINCT p ORDER BY p.rating DESC LIMIT ${limit}`;

    const rows = await executeQuery(query, params);

    const packages: PackageNode[] = rows.map((row) => {
      const props = extractNode(row as Record<string, unknown>, "p");
      return normalizePackage(props);
    });

    // Batch-fetch travel cities for each package via VISITS edges
    const packageCodes = packages.map((p) => p.code).filter(Boolean);
    if (packageCodes.length > 0) {
      try {
        const cityRows = await executeQuery<{ code: string; cities: string[] }>(
          "MATCH (p:Package)-[:VISITS]->(c:City) " +
          "WHERE p.code IN $codes " +
          "RETURN p.code AS code, collect(DISTINCT c.name) AS cities",
          { codes: packageCodes }
        );

        const cityMap = new Map<string, string>();
        for (const row of cityRows) {
          if (row.code && Array.isArray(row.cities) && row.cities.length > 0) {
            cityMap.set(row.code, row.cities.join(", "));
          }
        }

        for (const pkg of packages) {
          const cities = cityMap.get(pkg.code);
          if (cities) {
            pkg.travel_cities = cities;
          }
        }
      } catch (cityErr) {
        console.warn("[/api/packages] City lookup failed:", cityErr);
      }
    }

    cacheSet(cacheKey, packages, TTL.SEMI_STATIC);
    return NextResponse.json(packages);
  } catch (error) {
    console.error("[/api/packages] Error:", error);
    return NextResponse.json(
      { error: "패키지 목록 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

function normalizePackage(props: Record<string, unknown>): PackageNode {
  const val = (key: string): unknown => props[key];

  const arrVal = (key: string): string[] => {
    const v = props[key];
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
