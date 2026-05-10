"""Synthesize Agent — Sonnet copywriter that runs post-day-details.

This agent never sees MCP tools or graph data directly. It receives a
compact prompt assembled by :class:`SynthesizeNode` (skeleton summary +
itinerary + user intent + reference summary) and returns a
:class:`SynthesizeOutput` with copywriting fields the orchestrator
splats onto the final ``PlanningOutput``.
"""

from __future__ import annotations

from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.models.model import CacheConfig

from src.config import SONNET_MODEL_ID
from src.models.output import SynthesizeOutput
from src.prompts.synthesize_system import SYNTHESIZE_SYSTEM_PROMPT


def create_synthesize_agent() -> Agent:
    """Create the Synthesize agent (Phase 3 copywriter)."""
    model = BedrockModel(
        model_id=SONNET_MODEL_ID,
        cache_config=CacheConfig(strategy="auto"),
        max_tokens=4096,
    )
    return Agent(
        model=model,
        system_prompt=SYNTHESIZE_SYSTEM_PROMPT,
        structured_output_model=SynthesizeOutput,
    )
