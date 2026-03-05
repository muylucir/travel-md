"""Day Detail Generation Agent -- Opus-based per-day itinerary planner (Phase 2)."""

from __future__ import annotations

from strands import Agent
from strands.models.bedrock import BedrockModel

from src.config import OPUS_MODEL_ID
from src.models.output import DayDetailOutput
from src.mcp_connection import get_mcp_client
from src.prompts.day_detail_system import DAY_DETAIL_SYSTEM_PROMPT


def create_day_detail_agent() -> Agent:
    """Create the day detail generation agent (Phase 2).

    Uses Opus for high-quality per-day planning with MCP tools
    for attraction/hotel/trend lookups.
    """
    model = BedrockModel(
        model_id=OPUS_MODEL_ID,
        max_tokens=4096,
    )

    mcp = get_mcp_client()
    mcp_tools = mcp.list_tools_sync()

    return Agent(
        model=model,
        system_prompt=DAY_DETAIL_SYSTEM_PROMPT,
        tools=mcp_tools,
        structured_output_model=DayDetailOutput,
    )
