"""Day Detail Generation Agent -- Opus-based per-day itinerary planner (Phase 2)."""

from __future__ import annotations

from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.models.model import CacheConfig
from strands.tools.mcp import MCPClient

from src.config import OPUS_MODEL_ID
from src.hooks import ValkeyCacheHook
from src.models.output import DayDetailOutput
from src.prompts.day_detail_system import DAY_DETAIL_SYSTEM_PROMPT


def create_day_detail_agent(mcp_client: MCPClient) -> Agent:
    """Create the day detail generation agent (Phase 2).

    Uses Opus for high-quality per-day planning with MCP tools for
    attraction/hotel/trend lookups. The caller owns the ``mcp_client``
    lifecycle so that parallel graph workers can hold independent
    clients (each worker has its own background thread / event loop /
    streamable HTTP session).
    """
    model = BedrockModel(
        model_id=OPUS_MODEL_ID,
        cache_config=CacheConfig(strategy="auto"),
        max_tokens=8192,
    )

    mcp_tools = mcp_client.list_tools_sync()

    return Agent(
        model=model,
        system_prompt=DAY_DETAIL_SYSTEM_PROMPT,
        tools=mcp_tools,
        structured_output_model=DayDetailOutput,
        hooks=[ValkeyCacheHook()],
    )
