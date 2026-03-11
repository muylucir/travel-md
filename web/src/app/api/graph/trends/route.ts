import { NextRequest, NextResponse } from "next/server";
import { getTraversal, mapToObject, parseJsonProperty } from "@/lib/gremlin";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";
import gremlin from "gremlin";

const __ = gremlin.process.statics;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = (gremlin.process as any).P;

/**
 * GET /api/graph/trends?region=xxx&country=xxx&city=xxx&min_score=0
 * Returns trends with spots from Neptune, with time-decay scoring.
 * Filters: city (most specific) > region > country. If all omitted, returns all trends.
 * Cached for 5 min; invalidated when trends are collected.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const region = searchParams.get("region") || "";
  const country = searchParams.get("country") || "";
  const city = searchParams.get("city") || "";
  const minScore = parseInt(searchParams.get("min_score") || "0", 10);

  const cacheKey = `trends:${region}:${country}:${city}:${minScore}`;
  const cached = cacheGet<{ trends: unknown[]; count: number }>(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const g = await getTraversal();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let raw: any[];

    // Build city filter based on most specific parameter
    const hasCityFilter = city || region || country;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buildCityFilter = (base: any) => {
      const located = base.out("LOCATED_IN").hasLabel("City");
      if (city) return located.has("name", city);
      if (region) return located.has("region", region);
      if (country) return located.has("country", country);
      return located;
    };

    if (hasCityFilter) {
      // Filtered: Trend → TrendSpot → City (by city/region/country)
      raw = await g
        .V()
        .hasLabel("Trend")
        .has("virality_score", P.gte(minScore))
        .where(
          buildCityFilter(__.out("FILMED_AT", "FEATURES"))
        )
        .project("trend", "spots")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .by((__ as any).valueMap(true))
        .by(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (__.out("FILMED_AT", "FEATURES") as any)
            .where(
              buildCityFilter(__)
            )
            .valueMap(true)
            .fold()
        )
        .toList();
    } else {
      // Overview: all trends with their spots
      raw = await g
        .V()
        .hasLabel("Trend")
        .has("virality_score", P.gte(minScore))
        .project("trend", "spots")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .by((__ as any).valueMap(true))
        .by(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (__.out("FILMED_AT", "FEATURES") as any)
            .valueMap(true)
            .fold()
        )
        .toList();
    }

    const now = new Date();
    const trends = [];

    for (const item of raw) {
      // .project() returns Map in gremlin JS, but handle plain objects too
      const getter = (obj: unknown, key: string): unknown => {
        if (obj instanceof Map) return obj.get(key);
        if (obj && typeof obj === "object") return (obj as Record<string, unknown>)[key];
        return undefined;
      };
      const trendMap = getter(item, "trend") as Map<string, unknown>;
      const spotMaps = (getter(item, "spots") || []) as Array<Map<string, unknown>>;

      const trend = mapToObject<Record<string, unknown>>(trendMap);
      const val = (key: string): unknown => {
        const v = trend[key];
        return Array.isArray(v) ? v[0] : v;
      };

      const virality = Number(val("virality_score") || 0);
      const decay = Number(val("decay_rate") || 0.1);
      const dateStr = String(val("date") || "");
      const keywords = parseJsonProperty<string[]>(val("keywords"), []);
      const evidence = parseJsonProperty<Array<Record<string, string>>>(val("evidence"), []);

      // Compute effective score with time decay
      let effectiveScore = virality;
      if (dateStr) {
        try {
          const trendDate = new Date(dateStr);
          const monthsElapsed = Math.max(
            0,
            (now.getFullYear() - trendDate.getFullYear()) * 12 +
              (now.getMonth() - trendDate.getMonth())
          );
          effectiveScore = virality * Math.pow(1 - decay, monthsElapsed);
        } catch {
          // keep original virality
        }
      }

      if (effectiveScore < minScore) continue;

      const spots = spotMaps.map((s: Map<string, unknown>) => {
        const spot = mapToObject<Record<string, unknown>>(s);
        const sv = (key: string): unknown => {
          const v = spot[key];
          return Array.isArray(v) ? v[0] : v;
        };
        return {
          id: String(sv("id") || ""),
          name: String(sv("name") || ""),
          description: String(sv("description") || ""),
          category: String(sv("category") || ""),
          lat: Number(sv("lat") || 0),
          lng: Number(sv("lng") || 0),
          photo_worthy: Boolean(sv("photo_worthy")),
        };
      });

      trends.push({
        id: String(val("id") || ""),
        title: String(val("title") || ""),
        type: String(val("type") || ""),
        source: String(val("source") || ""),
        date: dateStr,
        virality_score: virality,
        decay_rate: decay,
        keywords,
        effective_score: Math.round(effectiveScore * 10) / 10,
        spots,
        evidence,
        tier: (() => {
          const serverTier = String(val("tier") || "");
          if (serverTier === "hot" || serverTier === "steady" || serverTier === "seasonal") return serverTier;
          return decay <= 0.10 ? "hot" : decay <= 0.25 ? "steady" : "seasonal";
        })(),
      });
    }

    // Sort by effective score descending
    trends.sort((a, b) => b.effective_score - a.effective_score);

    const result = { trends, count: trends.length };
    cacheSet(cacheKey, result, TTL.TRENDS);

    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/graph/trends] Error:", error);
    return NextResponse.json(
      { error: "트렌드 조회 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
