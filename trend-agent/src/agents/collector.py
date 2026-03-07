"""Trend Collector agent — Sonnet + MCP tools."""

from __future__ import annotations

from datetime import date

from strands import Agent
from strands.models.bedrock import BedrockModel

from src.config import BEDROCK_REGION, SONNET_MODEL_ID
from src.mcp_connection import get_mcp_client
from src.prompts.collector_system import COLLECTOR_SYSTEM_PROMPT


def create_collector_agent() -> Agent:
    """Create a Strands Agent for trend collection with MCP tools."""
    mcp_client = get_mcp_client()
    tools = mcp_client.list_tools_sync()

    model = BedrockModel(
        model_id=SONNET_MODEL_ID,
        region_name=BEDROCK_REGION,
        max_tokens=8192,
    )

    system_prompt = COLLECTOR_SYSTEM_PROMPT.replace("{today}", date.today().isoformat())

    agent = Agent(
        model=model,
        tools=tools,
        system_prompt=system_prompt,
    )
    return agent
