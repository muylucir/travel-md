import { NextRequest, NextResponse } from "next/server";
import { executeQuery, extractNode } from "@/lib/neptune";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";

/**
 * GET /api/packages/[code]
 *
 * v3 SaleProduct 상세 조회. Lambda graph_tools.get_package 와 동일한 모양:
 *   { saleProduct, arrivalCity, visitCities, attractions[], hotelStays[],
 *     flightSegments[], brand }
 *
 * UI 의 비교 패널 (기준 상품) 데이터 소스로 사용.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  if (!code) {
    return NextResponse.json({ error: "saleProdCd is required" }, { status: 400 });
  }

  const cacheKey = `package:v3:${code}`;
  const cached = cacheGet<unknown>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    // SaleProduct
    const pkgRows = await executeQuery(
      "MATCH (p:SaleProduct {saleProdCd: $code}) RETURN p",
      { code }
    );
    if (pkgRows.length === 0) {
      return NextResponse.json(
        { error: `SaleProduct '${code}' not found` },
        { status: 404 }
      );
    }
    const saleProduct = extractNode(pkgRows[0] as Record<string, unknown>, "p");

    // VISITS_CITY
    const visitRows = await executeQuery(
      "MATCH (p:SaleProduct {saleProdCd: $code})-[v:VISITS_CITY]->(c:City) " +
        "RETURN c, v.source AS source",
      { code }
    );
    const visitCities = visitRows.map((row) => {
      const r = row as Record<string, unknown>;
      const c = extractNode(r, "c");
      c.source = r.source;
      return c;
    });

    // ARRIVES_IN
    const arrRows = await executeQuery(
      "MATCH (p:SaleProduct {saleProdCd: $code})-[:ARRIVES_IN]->(c:City) RETURN c",
      { code }
    );
    const arrivalCity =
      arrRows.length > 0
        ? extractNode(arrRows[0] as Record<string, unknown>, "c")
        : null;

    // HAS_SCHEDULED_ATTRACTION (multigraph: schdDay, schtExprSqc)
    const attrRows = await executeQuery(
      "MATCH (p:SaleProduct {saleProdCd: $code})-[r:HAS_SCHEDULED_ATTRACTION]->(a:Attraction) " +
        "RETURN a, r.schdDay AS schdDay, r.schtExprSqc AS schtExprSqc " +
        "ORDER BY r.schdDay, r.schtExprSqc",
      { code }
    );
    const attractions = attrRows.map((row) => {
      const r = row as Record<string, unknown>;
      const a = extractNode(r, "a");
      a.schdDay = r.schdDay;
      a.schtExprSqc = r.schtExprSqc;
      return a;
    });

    // HAS_HOTEL_STAY → MATCHED_TO Hotel
    const stayRows = await executeQuery(
      "MATCH (p:SaleProduct {saleProdCd: $code})-[hs:HAS_HOTEL_STAY]->(s:HotelStay) " +
        "OPTIONAL MATCH (s)-[:MATCHED_TO]->(h:Hotel) " +
        "RETURN s, h, hs.schdDay AS schdDay " +
        "ORDER BY hs.schdDay",
      { code }
    );
    const hotelStays = stayRows.map((row) => {
      const r = row as Record<string, unknown>;
      const stay = extractNode(r, "s");
      const h = r.h;
      if (
        h &&
        typeof h === "object" &&
        (h as Record<string, unknown>)["~properties"]
      ) {
        stay.hotel = extractNode(r, "h");
      } else {
        stay.hotel = null;
      }
      stay.schdDay = r.schdDay;
      return stay;
    });

    // HAS_FLIGHT_SEGMENT
    const segRows = await executeQuery(
      "MATCH (p:SaleProduct {saleProdCd: $code})-[:HAS_FLIGHT_SEGMENT]->(f:FlightSegment) " +
        "OPTIONAL MATCH (f)-[:DEPARTS_FROM_AIRPORT]->(da:Airport) " +
        "OPTIONAL MATCH (f)-[:ARRIVES_AT_AIRPORT]->(aa:Airport) " +
        "RETURN f, da, aa ORDER BY f.segReq",
      { code }
    );
    const flightSegments = segRows.map((row) => {
      const r = row as Record<string, unknown>;
      const seg = extractNode(r, "f");
      const da = r.da;
      const aa = r.aa;
      if (
        da &&
        typeof da === "object" &&
        (da as Record<string, unknown>)["~properties"]
      ) {
        seg.depAirport = extractNode(r, "da");
      }
      if (
        aa &&
        typeof aa === "object" &&
        (aa as Record<string, unknown>)["~properties"]
      ) {
        seg.arrAirport = extractNode(r, "aa");
      }
      return seg;
    });

    // HAS_BRAND
    const brandRows = await executeQuery(
      "MATCH (p:SaleProduct {saleProdCd: $code})-[:HAS_BRAND]->(b:Brand) RETURN b",
      { code }
    );
    const brand =
      brandRows.length > 0
        ? extractNode(brandRows[0] as Record<string, unknown>, "b")
        : null;

    const result = {
      saleProduct,
      arrivalCity,
      visitCities,
      attractions,
      hotelStays,
      flightSegments,
      brand,
    };

    cacheSet(cacheKey, result, TTL.SEMI_STATIC);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/packages/[code]] Error:", error);
    return NextResponse.json(
      { error: "패키지 상세 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
