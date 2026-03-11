import { NextRequest } from "next/server";
import { invokeTrendCollector } from "@/lib/agentcore";
import { cacheInvalidate } from "@/lib/api-cache";

/**
 * POST /api/trends/collect
 *
 * Invokes the Trend Collector AgentCore Runtime.
 * Streams SSE events back to the client.
 */
export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        const str = typeof data === "string" ? data : JSON.stringify(data);
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${str}\n\n`));
      };

      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          // controller may be closed
        }
      }, 8000);

      try {
        const body = await request.json();
        const country = body.country || body.region; // backward compat
        const city = body.city || "";

        if (!country) {
          send("error", { message: "country parameter is required" });
          controller.close();
          return;
        }

        const label = city ? `${country} > ${city}` : country;
        send("progress", { step: `트렌드 수집 시작: ${label}`, percent: 5 });

        const payload: Record<string, string> = { country };
        if (city) payload.city = city;
        const agentResponse = await invokeTrendCollector(payload);

        if (!agentResponse.ok) {
          const errorText = await agentResponse.text();
          send("error", {
            message: `AgentCore 오류 (${agentResponse.status}): ${errorText}`,
          });
          controller.close();
          return;
        }

        if (!agentResponse.body) {
          send("error", { message: "AgentCore 응답에 스트림이 없습니다." });
          controller.close();
          return;
        }

        const contentType = agentResponse.headers.get("content-type") || "";

        if (contentType.includes("text/event-stream")) {
          const reader = agentResponse.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          } finally {
            reader.releaseLock();
          }
        } else {
          const json = await agentResponse.json();
          const payloadStr =
            typeof json.payload === "string"
              ? json.payload
              : JSON.stringify(json.payload || json);

          let events: Array<{ event: string; data: unknown }> = [];
          try {
            const parsed = JSON.parse(payloadStr);
            if (Array.isArray(parsed)) {
              events = parsed;
            } else if (parsed.event) {
              events = [parsed];
            } else {
              events = [{ event: "result", data: parsed }];
            }
          } catch {
            events = [{ event: "result", data: payloadStr }];
          }

          for (const evt of events) {
            send(evt.event, evt.data);
          }
        }

        // Invalidate trend caches so the dashboard shows fresh data
        cacheInvalidate("trends:");
      } catch (error) {
        console.error("[/api/trends/collect] Error:", error);
        const msg =
          error instanceof Error
            ? error.message
            : "트렌드 수집 중 오류가 발생했습니다.";
        try {
          const str = JSON.stringify({ message: msg });
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${str}\n\n`)
          );
        } catch {
          // controller may be closed
        }
      } finally {
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
