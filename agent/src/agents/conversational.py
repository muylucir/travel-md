"""Conversational Travel Assistant Agent -- Sonnet-based multi-turn chat."""

from __future__ import annotations

from strands import Agent
from strands.agent.conversation_manager import SlidingWindowConversationManager
from strands.models.bedrock import BedrockModel
from strands.models.model import CacheConfig

from src.config import SONNET_MODEL_ID
from src.hooks import ValkeyCacheHook
from src.mcp_connection import get_mcp_client
from src.prompts.conversational_system import CONVERSATIONAL_SYSTEM_PROMPT


def create_conversational_agent() -> Agent:
    """Create a multi-turn conversational agent with MCP tools.

    Uses Sonnet for fast responses.  Has access to all 12 MCP tools
    via the AgentCore Gateway for search/info queries.  Does NOT
    produce structured output -- returns free-text Korean responses.
    """
    model = BedrockModel(
        model_id=SONNET_MODEL_ID,
        cache_config=CacheConfig(strategy="auto"),
        max_tokens=8192,
    )

    mcp = get_mcp_client()
    mcp_tools = mcp.list_tools_sync()

    agent = Agent(
        model=model,
        system_prompt=CONVERSATIONAL_SYSTEM_PROMPT,
        tools=mcp_tools,
        conversation_manager=SlidingWindowConversationManager(window_size=40),
        hooks=[ValkeyCacheHook()],
    )

    return agent
