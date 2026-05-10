"""BedrockAgentCoreApp entrypoint for AgentCore Runtime deployment.

Supports two modes:
- mode="form" (default): Existing DAG pipeline (parse→collect→generate→validate)
- mode="chat": Multi-turn conversational agent with streaming + planning trigger

Tools are accessed via AgentCore Gateway MCP protocol.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time

from bedrock_agentcore.runtime import BedrockAgentCoreApp

# Heavy imports (strands, bedrock, mcp, pydantic) are deferred to first
# invocation so that AgentCore Runtime initialization completes within 30s.

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

app = BedrockAgentCoreApp()

# Lazy singletons
_skeleton_graph = None
_conversational_agent = None


def _get_skeleton_graph():
    global _skeleton_graph
    if _skeleton_graph is None:
        from src.orchestrator.graph import create_planning_graph
        _skeleton_graph = create_planning_graph()
    return _skeleton_graph


def _get_conversational_agent():
    global _conversational_agent
    if _conversational_agent is None:
        from src.agents.conversational import create_conversational_agent
        _conversational_agent = create_conversational_agent()
    return _conversational_agent


# ---------------------------------------------------------------------------
# Entrypoint — routes to chat or planning based on mode
# ---------------------------------------------------------------------------
@app.entrypoint
async def invoke(payload, context):
    """AgentCore Runtime entrypoint."""
    # Unwrap SDK invoke envelope if present
    if "payload" in payload and isinstance(payload.get("payload"), str):
        try:
            payload = json.loads(payload["payload"])
        except (json.JSONDecodeError, TypeError):
            pass

    mode = payload.get("mode", "form")

    if mode == "chat":
        async for event in _handle_chat(payload):
            yield event
    else:
        async for event in _handle_planning(payload):
            yield event


# ---------------------------------------------------------------------------
# Chat mode — multi-turn conversational agent with streaming
# ---------------------------------------------------------------------------
PLANNING_TRIGGER_RE = re.compile(r"<!--PLANNING_TRIGGER:(.*?)-->", re.DOTALL)


async def _handle_chat(payload):
    """Handle a multi-turn chat message with streaming."""
    user_message = payload.get("message", "")
    history = payload.get("history", [])

    if not user_message:
        yield {"event": "error", "data": {"message": "메시지가 비어있습니다."}}
        return

    try:
        agent = _get_conversational_agent()

        # Restore conversation history from frontend
        agent.messages.clear()
        for msg in history:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role in ("user", "assistant") and content:
                agent.messages.append({
                    "role": role,
                    "content": [{"text": content}],
                })

        # Stream the agent response token by token
        full_text = ""
        chunk_buffer = ""
        last_flush = time.time()

        async for event in agent.stream_async(user_message):
            if not isinstance(event, dict):
                continue

            # Extract text chunks from streaming events
            data = event.get("data")
            if data is not None:
                text = ""
                if isinstance(data, str):
                    text = data
                elif isinstance(data, dict):
                    text = data.get("text", "")

                if text:
                    full_text += text
                    chunk_buffer += text

                    # Flush every 300ms to keep the connection alive
                    now = time.time()
                    if now - last_flush >= 0.3 and chunk_buffer:
                        yield {"event": "message_chunk", "data": {"chunk": chunk_buffer}}
                        chunk_buffer = ""
                        last_flush = now

            # Detect tool use events for status feedback
            tool_use = event.get("current_tool_use")
            if tool_use:
                tool_name = tool_use.get("name", "") if isinstance(tool_use, dict) else getattr(tool_use, "name", "")
                if tool_name:
                    display_name = tool_name.split("___")[-1] if "___" in tool_name else tool_name
                    yield {"event": "tool_use", "data": {"tool": display_name}}

        # Flush remaining buffer
        if chunk_buffer:
            yield {"event": "message_chunk", "data": {"chunk": chunk_buffer}}

        # Check for planning trigger in the complete text
        trigger_match = PLANNING_TRIGGER_RE.search(full_text)

        if trigger_match:
            # Extract display text (before the marker)
            display_text = full_text[:trigger_match.start()].strip()
            # Remove any trailing marker remnants
            display_text = PLANNING_TRIGGER_RE.sub("", display_text).strip()

            yield {"event": "message_complete", "data": {"content": display_text}}

            # Parse planning parameters and trigger the pipeline
            try:
                planning_params = json.loads(trigger_match.group(1))
                logger.info("Planning trigger detected: %s", planning_params)
                async for event in _handle_planning(planning_params):
                    yield event
            except (json.JSONDecodeError, Exception) as e:
                logger.error("Failed to parse planning trigger: %s", e)
                yield {"event": "error", "data": {"message": f"기획 파라미터 파싱 실패: {e}"}}
        else:
            # Pure conversational response — send complete message
            yield {"event": "message_complete", "data": {"content": full_text}}

    except Exception as e:
        logger.exception("Chat handler failed")
        yield {"event": "error", "data": {"message": str(e)}}


# ---------------------------------------------------------------------------
# Graph runner helpers
# ---------------------------------------------------------------------------
async def _stream_keepalive(graph, task_input, invocation_state, *, base_pct, cap_pct):
    """Run a graph and yield progress percentages while it executes.

    Heartbeats every 10s prevent the SSE connection from idling out.  Pct
    grows linearly from base_pct toward cap_pct so the user sees motion.
    """
    queue: asyncio.Queue = asyncio.Queue()

    async def _runner():
        try:
            await graph.invoke_async(task_input, invocation_state)
            await queue.put(("done", None))
        except Exception as exc:
            await queue.put(("error", exc))

    async def _heartbeat():
        tick = 0
        while True:
            await asyncio.sleep(10)
            tick += 1
            pct = min(base_pct + tick * 5, cap_pct)
            await queue.put(("tick", pct))

    runner = asyncio.create_task(_runner())
    beat = asyncio.create_task(_heartbeat())
    try:
        while True:
            kind, payload = await queue.get()
            if kind == "done":
                return
            if kind == "error":
                raise payload
            if kind == "tick":
                yield payload
    finally:
        beat.cancel()
        try:
            await beat
        except asyncio.CancelledError:
            pass
        if not runner.done():
            try:
                await runner
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Planning mode — two-stage DAG pipeline (form mode + chat trigger)
# ---------------------------------------------------------------------------
async def _handle_planning(payload):
    """Run the existing DAG planning pipeline. Used by both form mode and chat trigger."""
    start_time = time.time()

    try:
        # Support both "prompt" wrapper and direct PlanningInput fields
        if "prompt" in payload and isinstance(payload["prompt"], str):
            try:
                input_data = json.loads(payload["prompt"])
            except json.JSONDecodeError:
                input_data = {
                    "input_mode": "chat",
                    "natural_language_request": payload["prompt"],
                    "destination": "오사카",
                    "duration": {"nights": 3, "days": 4},
                    "departure_season": "봄",
                    "similarity_level": 50,
                    "themes": [],
                }
        else:
            input_data = payload

        yield {"event": "progress", "data": {"step": "입력 파싱 중...", "percent": 5}}

        from src.models.input import PlanningInput
        planning_input = PlanningInput(**input_data)

        invocation_state = {
            "planning_input": planning_input.model_dump(),
        }

        yield {"event": "progress", "data": {"step": "컨텍스트 수집 중...", "percent": 15}}

        # ── Stage 1: skeleton graph (parse → collect → skeleton ↔ validate)
        skeleton_graph = _get_skeleton_graph()

        yield {"event": "progress", "data": {"step": "골격 생성 중...", "percent": 25}}

        async for pct in _stream_keepalive(
            skeleton_graph,
            json.dumps(planning_input.model_dump(), ensure_ascii=False),
            invocation_state,
            base_pct=25,
            cap_pct=45,
        ):
            yield {"event": "progress", "data": {"step": "골격 생성 중...", "percent": pct}}

        # ── Stage 2: per-request day-details graph with N parallel workers
        from src.models.output import PlanningOutput, SkeletonOutput
        skeleton_data = invocation_state.get("skeleton_output")
        if not skeleton_data:
            raise RuntimeError("Skeleton stage produced no skeleton_output")
        skeleton = SkeletonOutput(**skeleton_data)
        day_count = skeleton.days

        from src.orchestrator.graph import create_day_details_graph
        day_graph = create_day_details_graph(day_count)

        yield {
            "event": "progress",
            "data": {"step": f"{day_count}일 상세 병렬 생성 중...", "percent": 50},
        }

        async for pct in _stream_keepalive(
            day_graph,
            "",
            invocation_state,
            base_pct=50,
            cap_pct=78,
        ):
            yield {
                "event": "progress",
                "data": {"step": f"{day_count}일 상세 병렬 생성 중...", "percent": pct},
            }

        yield {"event": "progress", "data": {"step": "검증 중...", "percent": 80}}

        planning_output_data = invocation_state.get("planning_output")
        if not (
            planning_output_data
            and isinstance(planning_output_data, dict)
            and len(planning_output_data) > 0
        ):
            raise RuntimeError("Day details stage produced no planning_output")
        output = PlanningOutput(**planning_output_data)

        elapsed = time.time() - start_time
        logger.info("Planning completed in %.2fs", elapsed)

        yield {"event": "progress", "data": {"step": "상품 저장 중...", "percent": 90}}
        saved_code = None
        try:
            from src.mcp_connection import get_mcp_client, prefixed
            product_json = output.model_dump_json()
            mcp = get_mcp_client()
            save_result = mcp.call_tool_sync(
                tool_use_id="save-product-1",
                name=prefixed("save_product"),
                arguments={"product_json": product_json},
            )
            # Extract server-generated product_code from save response
            if hasattr(save_result, "content") and save_result.content:
                for block in save_result.content:
                    if hasattr(block, "text"):
                        try:
                            save_data = json.loads(block.text)
                            saved_code = save_data.get("product_code")
                        except (json.JSONDecodeError, AttributeError):
                            pass
            logger.info("Saved product via MCP Gateway: %s", saved_code or save_result)
        except Exception as save_err:
            logger.warning("Failed to save product via MCP: %s", save_err)

        yield {"event": "progress", "data": {"step": "완료", "percent": 100}}

        validation_result = invocation_state.get("validation_result")
        if validation_result:
            yield {"event": "validation", "data": validation_result}

        # Build final result with server-side corrections
        result_data = output.model_dump()
        if saved_code:
            result_data["product_code"] = saved_code
        from datetime import datetime, timezone
        end_time_utc = datetime.now(timezone.utc)
        result_data["generated_at"] = end_time_utc.isoformat()
        result_data["planning_started_at"] = datetime.fromtimestamp(start_time, tz=timezone.utc).isoformat()
        result_data["planning_finished_at"] = end_time_utc.isoformat()
        result_data["planning_elapsed_seconds"] = round(time.time() - start_time, 1)

        yield {"event": "result", "data": result_data}

    except Exception as e:
        logger.exception("Planning handler failed")
        yield {"event": "error", "data": {"message": str(e)}}


if __name__ == "__main__":
    app.run()
