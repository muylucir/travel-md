"""Skeleton Generation Agent -- Sonnet-based travel structure planner (Phase 1)."""

from __future__ import annotations

from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.models.model import CacheConfig

from src.config import SONNET_MODEL_ID
from src.models.output import SkeletonOutput
from src.prompts.skeleton_system import SKELETON_SYSTEM_PROMPT


def create_skeleton_agent() -> Agent:
    """Create the skeleton generation agent (Phase 1).

    Uses Sonnet for fast structure generation. No MCP tools needed —
    the graph context is passed in the user message.
    """
    model = BedrockModel(
        model_id=SONNET_MODEL_ID,
        cache_config=CacheConfig(strategy="auto"),
        max_tokens=8192,
    )

    return Agent(
        model=model,
        system_prompt=SKELETON_SYSTEM_PROMPT,
        structured_output_model=SkeletonOutput,
    )
