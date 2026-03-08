"""Itinerary Generation Agent -- Opus-based travel package planner.

Tools are provided via AgentCore Gateway MCP instead of direct graph tools.
"""

from __future__ import annotations

from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.models.model import CacheConfig

from src.config import OPUS_MODEL_ID
from src.hooks import ValkeyCacheHook
from src.models.output import PlanningOutput
from src.prompts.itinerary_system import ITINERARY_SYSTEM_PROMPT
from src.mcp_connection import get_mcp_client


def create_itinerary_agent() -> Agent:
    """Create and return the itinerary generation agent.

    This agent uses Claude Opus with MCP tools from AgentCore Gateway
    and produces structured PlanningOutput via Structured Output.
    """
    opus_model = BedrockModel(
        model_id=OPUS_MODEL_ID,
        cache_config=CacheConfig(strategy="auto"),
        max_tokens=8192,
    )

    mcp = get_mcp_client()
    mcp_tools = mcp.list_tools_sync()

    agent = Agent(
        model=opus_model,
        system_prompt=ITINERARY_SYSTEM_PROMPT,
        tools=mcp_tools,
        structured_output_model=PlanningOutput,
        hooks=[ValkeyCacheHook()],
    )

    return agent
