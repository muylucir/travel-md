import { NextRequest } from "next/server";
import { invokeAgentCore } from "@/lib/agentcore";

/**
 * POST /api/planning
 *
 * Invokes AgentCore Runtime with SigV4 auth.  Sends SSE keepalive
 * heartbeats to the browser while waiting for the (potentially slow)
 * AgentCore response, preventing connection timeouts.
 */
export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        const str = typeof data === "string" ? data : JSON.stringify(data);
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${str}\n\n`));
      };

      // SSE comment keepalive — browsers ignore `:` lines but they
      // reset the network idle timer.
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          // controller may be closed
        }
      }, 8000);

      try {
        const body = await request.json();

        const agentResponse = await invokeAgentCore(body);

        if (!agentResponse.ok) {
          const errorText = await agentResponse.text();
          send("error", { message: `AgentCore 오류 (${agentResponse.status}): ${errorText}` });
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
          // Stream — pipe through chunk by chunk
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
          // JSON response — parse payload and emit as SSE events
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
      } catch (error) {
        console.error("[/api/planning] Error:", error);
        const msg =
          error instanceof Error
            ? error.message
            : "기획 요청 처리 중 오류가 발생했습니다.";
        try {
          const str = JSON.stringify({ message: msg });
          controller.enqueue(encoder.encode(`event: error\ndata: ${str}\n\n`));
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
