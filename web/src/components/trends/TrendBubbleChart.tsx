"use client";

import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ZAxis,
} from "recharts";
import {
  Trend,
  getTrendStatus,
  getFreshnessDays,
  getStatusLabel,
} from "@/hooks/useTrends";

const STATUS_COLORS: Record<string, string> = {
  hot: "#d13212",
  steady: "#0972d3",
  emerging: "#037f0c",
  stale: "#8d9096",
};

interface Props {
  trends: Trend[];
}

export default function TrendBubbleChart({ trends }: Props) {
  const data = trends.map((t) => {
    const status = getTrendStatus(t);
    return {
      name: t.title,
      freshness: getFreshnessDays(t.date),
      virality: t.virality_score,
      effectiveScore: t.effective_score,
      status,
      color: STATUS_COLORS[status],
      source: t.source,
    };
  });

  return (
    <div style={{ width: "100%", height: 320 }}>
      <ResponsiveContainer>
        <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
          <XAxis
            type="number"
            dataKey="freshness"
            name="Freshness (days)"
            unit="일"
            reversed
            label={{
              value: "Freshness (일 전)",
              position: "insideBottom",
              offset: -5,
            }}
          />
          <YAxis
            type="number"
            dataKey="virality"
            name="Virality"
            label={{
              value: "Virality Score",
              angle: -90,
              position: "insideLeft",
            }}
          />
          <ZAxis
            type="number"
            dataKey="effectiveScore"
            range={[40, 400]}
          />
          <Tooltip
            content={({ payload }) => {
              if (!payload || !payload.length) return null;
              const d = payload[0].payload;
              return (
                <div
                  style={{
                    background: "#fff",
                    border: "1px solid #e9ebed",
                    padding: "8px 12px",
                    borderRadius: 8,
                    fontSize: 13,
                  }}
                >
                  <strong>{d.name}</strong>
                  <br />
                  소스: {d.source} | {getStatusLabel(d.status)}
                  <br />
                  Virality: {d.virality} | {d.freshness}일 전
                </div>
              );
            }}
          />
          <Scatter data={data}>
            {data.map((entry, idx) => (
              <Cell key={idx} fill={entry.color} fillOpacity={0.7} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
      <div
        style={{
          display: "flex",
          gap: 16,
          justifyContent: "center",
          marginTop: 4,
          fontSize: 13,
        }}
      >
        {(["hot", "steady", "emerging", "stale"] as const).map((s) => (
          <span key={s} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: STATUS_COLORS[s],
                display: "inline-block",
              }}
            />
            {getStatusLabel(s)}
          </span>
        ))}
      </div>
    </div>
  );
}
