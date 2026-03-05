"""Chat Parser Agent -- Sonnet-based natural language to PlanningInput converter."""

from __future__ import annotations

from strands import Agent
from strands.models.bedrock import BedrockModel

from src.config import SONNET_MODEL_ID
from src.models.input import PlanningInput
from src.prompts.chat_parser_system import CHAT_PARSER_SYSTEM_PROMPT


def create_chat_parser_agent() -> Agent:
    """Create and return the chat parser agent.

    This agent uses Claude Sonnet to parse Korean natural language input
    into a structured PlanningInput model. It is only invoked in Mode A
    (chat mode).
    """
    sonnet_model = BedrockModel(
        model_id=SONNET_MODEL_ID,
        max_tokens=4096,
    )

    agent = Agent(
        model=sonnet_model,
        system_prompt=CHAT_PARSER_SYSTEM_PROMPT,
        structured_output_model=PlanningInput,
    )

    return agent
