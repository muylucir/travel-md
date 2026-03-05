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

from src.agents.conversational import create_conversational_agent
from src.models.input import PlanningInput
from src.models.output import PlanningOutput
from src.orchestrator.graph import create_planning_graph
from src.mcp_connection import get_mcp_client, prefixed

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

app = BedrockAgentCoreApp()

# Lazy singletons
_graph = None
_conversational_agent = None


def _get_graph():
    global _graph
    if _graph is None:
        _graph = create_planning_graph()
    return _graph


def _get_conversational_agent():
    global _conversational_agent
    if _conversational_agent is None:
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
# Planning mode — existing DAG pipeline (form mode + chat trigger)
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

        planning_input = PlanningInput(**input_data)

        invocation_state = {
            "planning_input": planning_input.model_dump(),
        }

        yield {"event": "progress", "data": {"step": "컨텍스트 수집 중...", "percent": 15}}

        graph = _get_graph()

        yield {"event": "progress", "data": {"step": "일정 생성 중...", "percent": 30}}

        # Run DAG with keepalive to prevent connection timeout.
        # The graph can take 60-120s (Opus generation + retries).
        # We send progress heartbeats every 10s to keep SSE alive.
        event_queue: asyncio.Queue = asyncio.Queue()

        async def _run_graph():
            try:
                r = await graph.invoke_async(
                    json.dumps(planning_input.model_dump(), ensure_ascii=False),
                    invocation_state,
                )
                await event_queue.put(("done", r))
            except Exception as exc:
                await event_queue.put(("error", exc))

        async def _keepalive():
            tick = 0
            while True:
                await asyncio.sleep(10)
                tick += 1
                pct = min(30 + tick * 5, 75)  # 35, 40, 45, ... 75
                await event_queue.put(("keepalive", pct))

        graph_task = asyncio.create_task(_run_graph())
        keepalive_task = asyncio.create_task(_keepalive())

        result = None
        try:
            while True:
                msg_type, msg_data = await event_queue.get()
                if msg_type == "done":
                    result = msg_data
                    break
                elif msg_type == "error":
                    raise msg_data
                elif msg_type == "keepalive":
                    yield {"event": "progress", "data": {"step": "일정 생성 중...", "percent": msg_data}}
        finally:
            keepalive_task.cancel()
            try:
                await keepalive_task
            except asyncio.CancelledError:
                pass

        yield {"event": "progress", "data": {"step": "검증 중...", "percent": 80}}

        planning_output_data = invocation_state.get("planning_output")

        if planning_output_data and isinstance(planning_output_data, dict) and len(planning_output_data) > 0:
            output = PlanningOutput(**planning_output_data)
        else:
            gen_result = result.results.get("generate_itinerary")
            validate_result = result.results.get("validate")
            target = gen_result or validate_result
            if target and target.result:
                output_text = str(target.result)
                for match in re.finditer(r"\{", output_text):
                    remainder = output_text[match.start():]
                    if '"package_name"' not in remainder[:5000]:
                        continue
                    depth = 0
                    for i, ch in enumerate(remainder):
                        if ch == "{":
                            depth += 1
                        elif ch == "}":
                            depth -= 1
                            if depth == 0:
                                try:
                                    parsed = json.loads(remainder[: i + 1])
                                    if "package_name" in parsed:
                                        output = PlanningOutput(**parsed)
                                        break
                                except (json.JSONDecodeError, Exception):
                                    pass
                                break
                    else:
                        continue
                    break
                else:
                    raise RuntimeError("Failed to extract PlanningOutput from graph result")
            else:
                raise RuntimeError("No planning output produced by the graph")

        elapsed = time.time() - start_time
        logger.info("Planning completed in %.2fs", elapsed)

        yield {"event": "progress", "data": {"step": "상품 저장 중...", "percent": 90}}
        saved_code = None
        try:
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
        result_data["generated_at"] = datetime.now(timezone.utc).isoformat()

        yield {"event": "result", "data": result_data}

    except Exception as e:
        logger.exception("Planning handler failed")
        yield {"event": "error", "data": {"message": str(e)}}


if __name__ == "__main__":
    app.run()
