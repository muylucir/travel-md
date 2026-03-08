"""Valkey cache hook for Strands Agent MCP tool calls.

Implements transparent read-through caching via Strands Hooks:
- BeforeToolCallEvent: on cache HIT, replaces selected_tool with a
  lightweight stub that returns the cached result immediately.
- AfterToolCallEvent: on cache MISS (real MCP call), stores the result.

Write tools (save_product, upsert_*, delete_*) are excluded.
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator

from strands.hooks import BeforeToolCallEvent, AfterToolCallEvent, HookProvider, HookRegistry
from strands.types.tools import AgentTool, ToolUse
from strands.types._events import ToolResultEvent

from src.cache import get_cache, ValkeyCache, WRITE_TOOLS
from src.mcp_connection import GATEWAY_TARGET_PREFIX

logger = logging.getLogger(__name__)


def _strip_prefix(tool_name: str) -> str:
    """Remove gateway prefix: 'travel-tools___get_attractions_by_city' -> 'get_attractions_by_city'."""
    prefix = f"{GATEWAY_TARGET_PREFIX}___"
    if tool_name.startswith(prefix):
        return tool_name[len(prefix):]
    return tool_name


def _is_cacheable(tool_name: str) -> bool:
    """Return True if this tool's results should be cached."""
    return _strip_prefix(tool_name) not in WRITE_TOOLS


class _CachedResultTool(AgentTool):
    """A minimal AgentTool that returns a pre-computed cached result.

    Injected into BeforeToolCallEvent.selected_tool on cache hits to
    short-circuit the actual MCP call.  Produces ``status: "success"``
    so the LLM sees a normal tool result.
    """

    def __init__(self, original_tool: AgentTool, cached_result: dict) -> None:
        super().__init__()
        self._original = original_tool
        self._cached_result = cached_result

    @property
    def tool_name(self) -> str:
        return self._original.tool_name

    @property
    def tool_spec(self) -> dict:
        return self._original.tool_spec

    @property
    def tool_type(self) -> str:
        return "python"

    async def stream(
        self, tool_use: ToolUse, invocation_state: dict[str, Any], **kwargs: Any,
    ) -> AsyncGenerator[Any, None]:
        """Yield the cached result immediately without any network call."""
        yield ToolResultEvent(self._cached_result)


class ValkeyCacheHook:
    """HookProvider that adds transparent Valkey caching to all read MCP tools.

    Usage::

        agent = Agent(tools=mcp_tools, hooks=[ValkeyCacheHook()])

    Both CollectContextNode (via direct cache.get/set) and Agent hooks share
    the same Valkey keyspace, so a cache entry written by one path is readable
    by the other.
    """

    def __init__(self, cache: ValkeyCache | None = None) -> None:
        self._cache = cache or get_cache()
        self._cache_hits: set[str] = set()

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool)
        registry.add_callback(AfterToolCallEvent, self._on_after_tool)

    def _on_before_tool(self, event: BeforeToolCallEvent) -> None:
        """Check cache before tool execution.  On hit, replace with cached stub."""
        tool_name = event.tool_use.get("name", "")
        if not _is_cacheable(tool_name):
            return

        bare_name = _strip_prefix(tool_name)
        arguments = event.tool_use.get("input", {})
        if not isinstance(arguments, dict):
            return

        try:
            cached = self._cache.get(bare_name, arguments)
        except Exception:
            logger.warning("Hook cache lookup error for %s — failing open", bare_name, exc_info=True)
            return

        if cached is None:
            return

        tool_use_id = event.tool_use.get("toolUseId", "")
        logger.info("Hook cache HIT: %s (tool_use_id=%s)", bare_name, tool_use_id)
        self._cache_hits.add(tool_use_id)

        # Build a ToolResult dict from cached data
        if isinstance(cached, list):
            content = cached
        elif isinstance(cached, dict) and "content" in cached:
            content = cached["content"]
        elif isinstance(cached, str):
            content = [{"text": cached}]
        else:
            content = [{"text": json.dumps(cached, ensure_ascii=False, default=str)}]

        cached_result: dict = {
            "toolUseId": str(tool_use_id),
            "status": "success",
            "content": content,
        }

        if event.selected_tool is not None:
            event.selected_tool = _CachedResultTool(event.selected_tool, cached_result)

    def _on_after_tool(self, event: AfterToolCallEvent) -> None:
        """On cache miss, store the successful result in Valkey."""
        tool_name = event.tool_use.get("name", "")
        tool_use_id = event.tool_use.get("toolUseId", "")

        if not _is_cacheable(tool_name):
            return

        # Skip if this was a cache hit (already from cache)
        if tool_use_id in self._cache_hits:
            self._cache_hits.discard(tool_use_id)
            return

        # Only cache successful results
        result = event.result
        if not isinstance(result, dict) or result.get("status") != "success":
            return

        bare_name = _strip_prefix(tool_name)
        arguments = event.tool_use.get("input", {})
        if not isinstance(arguments, dict):
            return

        content = result.get("content", [])
        try:
            self._cache.set(bare_name, arguments, content)
            logger.info("Hook cache SET: %s", bare_name)
        except Exception:
            logger.warning("Hook cache store error for %s — failing open", bare_name, exc_info=True)
