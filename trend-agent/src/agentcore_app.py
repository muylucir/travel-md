"""BedrockAgentCoreApp entrypoint for Trend Collector Runtime.

Accepts a region parameter and runs the trend collection agent.
"""

from __future__ import annotations

import json
import logging
import time

from bedrock_agentcore.runtime import BedrockAgentCoreApp

from src.agents.collector import create_collector_agent
from src.mcp_connection import get_mcp_client

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

app = BedrockAgentCoreApp()

_agent = None


def _get_agent():
    global _agent
    if _agent is None:
        _agent = create_collector_agent()
    return _agent


@app.entrypoint
async def invoke(payload, context):
    """AgentCore Runtime entrypoint for trend collection."""
    # Unwrap SDK invoke envelope if present
    if "payload" in payload and isinstance(payload.get("payload"), str):
        try:
            payload = json.loads(payload["payload"])
        except (json.JSONDecodeError, TypeError):
            pass

    country = payload.get("country") or payload.get("region", "")
    city = payload.get("city", "")
    if not country:
        yield {"event": "error", "data": {"message": "country parameter is required"}}
        return

    label = f"{country} > {city}" if city else country
    yield {"event": "progress", "data": {"step": f"트렌드 수집 시작: {label}", "percent": 5}}

    start_time = time.time()

    try:
        agent = _get_agent()

        # Clear previous conversation
        agent.messages.clear()

        if city:
            prompt = (
                f"국가: {country}\n도시: {city}\n\n"
                f"이 도시({city})에 집중하여 최신 여행 트렌드를 수집하고 Neptune에 저장해주세요.\n"
                f"get_cities_by_country는 호출하지 않아도 됩니다. 도시명 '{city}'를 그대로 사용하세요."
            )
        else:
            prompt = f"국가: {country}\n\n이 국가의 최신 여행 트렌드를 수집하고 Neptune에 저장해주세요."

        yield {"event": "progress", "data": {"step": "에이전트 실행 중...", "percent": 10}}

        # Stream agent — emit tool_use and progress events in real-time
        full_text = ""
        tool_count = 0

        async for event in agent.stream_async(prompt):
            if not isinstance(event, dict):
                continue

            # Detect tool use events
            tool_use = event.get("current_tool_use")
            if tool_use:
                name = tool_use.get("name", "") if isinstance(tool_use, dict) else getattr(tool_use, "name", "")
                if name:
                    display = name.split("___")[-1] if "___" in name else name
                    tool_count += 1
                    pct = min(20 + int(tool_count * 4.5), 95)
                    yield {"event": "tool_use", "data": {"tool": display}}
                    yield {"event": "progress", "data": {"step": display, "percent": pct}}

            # Buffer text for final summary extraction
            data = event.get("data")
            if data is not None:
                text = ""
                if isinstance(data, str):
                    text = data
                elif isinstance(data, dict):
                    text = data.get("text", "")
                if text:
                    full_text += text

        elapsed = time.time() - start_time
        logger.info("Trend collection for %s completed in %.2fs", label, elapsed)

        # Invalidate planning agent trend cache so fresh data is served
        try:
            mcp = get_mcp_client()
            mcp.call_tool_sync(
                tool_use_id="cache-inv-1",
                name="travel-tools___invalidate_cache",
                arguments={"tool_pattern": "get_trends"},
            )
            logger.info("Trend cache invalidated after collection for %s", label)
        except Exception as inv_err:
            logger.warning("Cache invalidation failed (non-fatal): %s", inv_err)

        # Try to extract JSON summary from agent response
        summary = None
        try:
            import re
            json_match = re.search(r"\{[^{}]*\"trends_collected\"[^{}]*\}", full_text)
            if json_match:
                summary = json.loads(json_match.group())
        except (json.JSONDecodeError, Exception):
            pass

        yield {"event": "progress", "data": {"step": "수집 완료", "percent": 100}}

        yield {
            "event": "result",
            "data": {
                "country": country,
                "city": city or None,
                "summary": summary or {"message": full_text[:500]},
                "elapsed_seconds": round(elapsed, 1),
            },
        }

    except Exception as e:
        logger.exception("Trend collection failed for %s", label)
        yield {"event": "error", "data": {"message": str(e)}}


if __name__ == "__main__":
    app.run()
