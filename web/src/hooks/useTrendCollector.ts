import { useState, useCallback } from "react";

interface CollectResult {
  country?: string;
  region?: string;
  summary: {
    trends_collected?: number;
    spots_collected?: number;
    links_created?: number;
    message?: string;
  };
  elapsed_seconds: number;
}

export interface CollectProgress {
  step: string;
  percent: number;
}

export function useTrendCollector() {
  const [collecting, setCollecting] = useState(false);
  const [result, setResult] = useState<CollectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<CollectProgress | null>(null);
  const [currentTool, setCurrentTool] = useState<string | null>(null);

  const collect = useCallback(async (country: string, city?: string) => {
    setCollecting(true);
    setError(null);
    setResult(null);
    setProgress(null);
    setCurrentTool(null);

    try {
      const body: Record<string, string> = { country };
      if (city) body.city = city;
      const res = await fetch("/api/trends/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let pendingEvent: string | null = null;

        for (const line of lines) {
          // SSE format: "event: xxx" followed by "data: yyy"
          if (line.startsWith("event: ")) {
            pendingEvent = line.slice(7).trim();
            continue;
          }

          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              const eventType = pendingEvent || data.event;
              pendingEvent = null;

              switch (eventType) {
                case "result":
                  setResult(data);
                  break;
                case "error":
                  setError(data?.message || "Collection failed");
                  break;
                case "progress":
                  setProgress({ step: data.step, percent: data.percent });
                  break;
                case "tool_use":
                  setCurrentTool(data.tool);
                  break;
              }
            } catch {
              pendingEvent = null;
            }
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setCollecting(false);
    }
  }, []);

  return { collecting, result, error, progress, currentTool, collect };
}
