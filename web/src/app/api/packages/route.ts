import { NextRequest, NextResponse } from "next/server";
import { executeQuery, extractNode } from "@/lib/neptune";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";
import type { PackageNode } from "@/lib/types";

/**
 * GET /api/packages
 *
 * v3 SaleProduct 검색.
 *
 * Query params:
 *   destination     - 도시 이름 또는 코드 (오사카 / OSA)
 *                     ARRIVES_IN 또는 VISITS_CITY 매칭
 *   theme_key       - v3 Theme.key (e.g. FAMILY_WITH_KIDS) — 일정에 해당
 *                     테마 가중치(IN_THEME.weight>0)가 있는 명소를 포함하는
 *                     SaleProduct만 반환
 *   season_quarter  - 1..4 (Season.quarter)
 *   nights          - trvlNgtCnt
 *   brand           - "세이브" | "스탠다드"
 *   limit           - max results (default 20)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const destination = searchParams.get("destination") || "";
  const themeKey = searchParams.get("theme_key") || searchParams.get("theme") || "";
  const seasonQuarterStr = searchParams.get("season_quarter") || "";
  const nights = searchParams.get("nights") || "";
  const brand = searchParams.get("brand") || "";
  const limit = parseInt(searchParams.get("limit") || "20", 10);

  const cacheKey = `packages:v3:${destination}:${themeKey}:${seasonQuarterStr}:${nights}:${brand}:${limit}`;
  const cached = cacheGet<PackageNode[]>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    // 1) 필수 MATCH 절을 먼저 모은다 (mandatory matches 만)
    const matchLines = ["MATCH (p:SaleProduct)"];
    const whereParts: string[] = [];
    const params: Record<string, unknown> = {};

    if (nights) {
      const n = parseInt(nights, 10);
      if (!isNaN(n)) {
        whereParts.push("p.trvlNgtCnt = $nights");
        params.nights = n;
      }
    }

    if (brand) {
      whereParts.push("p.brndNm = $brand");
      params.brand = brand;
    }

    if (themeKey) {
      matchLines.push(
        "MATCH (p)-[:HAS_SCHEDULED_ATTRACTION]->(:Attraction)-[it:IN_THEME]->(:Theme {key: $theme_key})"
      );
      whereParts.push("it.weight > 0");
      params.theme_key = themeKey;
    }

    const seasonQuarter = parseInt(seasonQuarterStr, 10);
    if (!isNaN(seasonQuarter) && seasonQuarter >= 1 && seasonQuarter <= 4) {
      matchLines.push(
        "MATCH (p)-[:HAS_SCHEDULED_ATTRACTION]->(:Attraction)-[bs:BEST_IN_SEASON]->(:Season {quarter: $q})"
      );
      whereParts.push("bs.weight > 0");
      params.q = seasonQuarter;
    }

    // 2) destination 매칭은 ARRIVES_IN(SaleProduct.arrCityNm/arrCityCd) 또는
    //    VISITS_CITY 둘 중 하나에 걸리면 OK. OpenCypher 는 OPTIONAL MATCH 다음
    //    MATCH 와 EXISTS{...} 서브쿼리를 모두 거부하므로, WHERE 절의 pattern
    //    expression `(p)-[:VISITS_CITY]->(:City {...})` 를 사용한다 (Neptune 지원).
    if (destination) {
      whereParts.push(
        "(p.arrCityNm = $dest OR p.arrCityCd = $dest OR " +
          "(p)-[:VISITS_CITY]->(:City {name: $dest}) OR " +
          "(p)-[:VISITS_CITY]->(:City {code: $dest}))"
      );
      params.dest = destination;
    }

    let query = matchLines.join("\n");
    if (whereParts.length > 0) {
      query += "\nWHERE " + whereParts.join(" AND ");
    }
    query += `\nRETURN DISTINCT p LIMIT ${limit}`;

    const rows = await executeQuery(query, params);

    const packages: PackageNode[] = rows.map((row) => {
      const props = extractNode(row as Record<string, unknown>, "p") as Record<
        string,
        unknown
      >;
      const code = String(props.saleProdCd || "");
      const arrCity = String(props.arrCityNm || "");
      const visitCsv = String(props.vistCityRawCsv || "");
      const trvlDay = Number(props.trvlDayCnt || 0);
      const trvlNgt = Number(props.trvlNgtCnt || 0);
      return {
        code,
        name: String(props.saleProdNm || code),
        description: String(props.prodSbttNm || ""),
        price: 0, // v3 SaleProduct 에 가격 속성 없음
        nights: trvlNgt,
        days: trvlDay,
        rating: 0, // v3 SaleProduct 에 rating 속성 없음
        season: [],
        hashtags: [],
        travel_cities: visitCsv ? `${arrCity} (${visitCsv})` : arrCity,
        // v3 추가 컨텍스트
        brand: String(props.brndNm || ""),
      } as PackageNode & { brand: string };
    });

    cacheSet(cacheKey, packages, TTL.SEMI_STATIC);
    return NextResponse.json(packages);
  } catch (error) {
    console.error("[/api/packages] Error:", error);
    return NextResponse.json(
      { error: "패키지 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
