import type { PlanningOutput, ProgressData } from "./types";

export interface SSECallbacks {
  onProgress?: (data: ProgressData) => void;
  onResult?: (data: PlanningOutput) => void;
  onError?: (error: string) => void;
  onMessageChunk?: (data: { chunk: string }) => void;
  onMessageComplete?: (data: { content: string }) => void;
  onToolUse?: (data: { tool: string }) => void;
}

/**
 * Sends a POST request and reads the SSE (Server-Sent Events) stream.
 * Parses `event:` and `data:` lines from the text/event-stream response.
 */
export async function fetchSSE(
  url: string,
  body: unknown,
  callbacks: SSECallbacks
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    callbacks.onError?.(
      `HTTP ${response.status}: ${text || response.statusText}`
    );
    return;
  }

  if (!response.body) {
    callbacks.onError?.("응답 스트림이 없습니다.");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep incomplete last line in buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === "") {
          // Empty line = end of event block, reset
          currentEvent = "message";
          continue;
        }

        if (trimmed.startsWith("event:")) {
          currentEvent = trimmed.slice(6).trim();
          continue;
        }

        if (trimmed.startsWith("data:")) {
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr) continue;

          try {
            const parsed = JSON.parse(dataStr);

            // AgentCore Runtime wraps events as: {"event":"...", "data":{...}}
            // Unwrap if nested, otherwise use currentEvent from SSE
            let eventType = currentEvent;
            let data = parsed;
            if (parsed.event && parsed.data !== undefined) {
              eventType = parsed.event;
              data = parsed.data;
            }

            switch (eventType) {
              case "progress":
                callbacks.onProgress?.(data as ProgressData);
                break;
              case "result":
                callbacks.onResult?.(data as PlanningOutput);
                break;
              case "error":
                callbacks.onError?.(data.message || JSON.stringify(data));
                break;
              case "message_chunk":
                callbacks.onMessageChunk?.(data as { chunk: string });
                break;
              case "message_complete":
                callbacks.onMessageComplete?.(data as { content: string });
                break;
              case "tool_use":
                callbacks.onToolUse?.(data as { tool: string });
                break;
              case "validation":
                break;
              default:
                if (data.step !== undefined && data.percent !== undefined) {
                  callbacks.onProgress?.(data as ProgressData);
                }
                break;
            }
          } catch {
            // Not JSON, ignore
          }
        }
      }
    }
  } catch (err) {
    callbacks.onError?.(
      err instanceof Error ? err.message : "스트림 읽기 오류"
    );
  } finally {
    reader.releaseLock();
  }
}
