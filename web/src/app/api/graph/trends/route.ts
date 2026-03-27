import { NextRequest, NextResponse } from "next/server";
import { executeQuery, extractNode, parseJsonProperty } from "@/lib/neptune";
import { cacheGet, cacheSet, TTL } from "@/lib/api-cache";

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
    // Build location filter for the City node
    const params: Record<string, unknown> = { min_score: minScore };
    let cityFilter = "";

    if (city) {
      cityFilter = "{name: $location}";
      params.location = city;
    } else if (region) {
      cityFilter = "{region: $location}";
      params.location = region;
    } else if (country) {
      cityFilter = "{country: $location}";
      params.location = country;
    }

    let query: string;
    if (cityFilter) {
      query =
        `MATCH (t:Trend)-[rel:FILMED_AT|FEATURES]->(ts:TrendSpot)-[:LOCATED_IN]->(c:City ${cityFilter}) ` +
        `WHERE t.virality_score >= $min_score ` +
        `WITH t, collect(DISTINCT ts) AS spots ` +
        `RETURN t, spots`;
    } else {
      query =
        `MATCH (t:Trend) WHERE t.virality_score >= $min_score ` +
        `OPTIONAL MATCH (t)-[:FILMED_AT|FEATURES]->(ts:TrendSpot) ` +
        `WITH t, collect(DISTINCT ts) AS spots ` +
        `RETURN t, spots`;
    }

    const raw = await executeQuery(query, params);
    const now = new Date();
    const trends = [];

    for (const item of raw) {
      const trendProps = extractNode(item as Record<string, unknown>, "t");

      const virality = Number(trendProps.virality_score || 0);
      const decay = Number(trendProps.decay_rate || 0.1);
      const dateStr = String(trendProps.date || "");
      const keywords = parseJsonProperty<string[]>(trendProps.keywords, []);
      const evidence = parseJsonProperty<Array<Record<string, string>>>(trendProps.evidence, []);

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

      const spotsRaw = (item as Record<string, unknown>).spots;
      const spots = Array.isArray(spotsRaw)
        ? spotsRaw.map((s) => {
            const sp = extractNode({ s }, "s");
            return {
              id: String(sp.id || ""),
              name: String(sp.name || ""),
              description: String(sp.description || ""),
              category: String(sp.category || ""),
              lat: Number(sp.lat || 0),
              lng: Number(sp.lng || 0),
              photo_worthy: Boolean(sp.photo_worthy),
            };
          })
        : [];

      trends.push({
        id: String(trendProps.id || ""),
        title: String(trendProps.title || ""),
        type: String(trendProps.type || ""),
        source: String(trendProps.source || ""),
        date: dateStr,
        virality_score: virality,
        decay_rate: decay,
        keywords,
        effective_score: Math.round(effectiveScore * 10) / 10,
        spots,
        evidence,
        tier: (() => {
          const serverTier = String(trendProps.tier || "");
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
