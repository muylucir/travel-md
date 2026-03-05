"""Valkey (Redis-compatible) caching layer for MCP tool results.

Caches tool responses with per-tool TTLs. Fails open on any Redis error
so the system degrades gracefully to direct MCP calls.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

import redis

from src.config import REDIS_HOST, REDIS_PORT

logger = logging.getLogger(__name__)

# TTL map in seconds, keyed by tool name substring
_TTL_MAP: dict[str, int] = {
    "routes": 86_400,       # 24h
    "attractions": 86_400,  # 24h
    "hotels": 86_400,       # 24h
    "nearby": 86_400,       # 24h
    "package": 43_200,      # 12h
    "similar": 43_200,      # 12h
    "trends": 21_600,       # 6h
    "search": 3_600,        # 1h
}
_DEFAULT_TTL: int = 3_600   # 1h fallback


class ValkeyCache:
    """Thin Redis/Valkey wrapper that caches MCP tool results with TTL."""

    def __init__(self, host: str = REDIS_HOST, port: int = REDIS_PORT) -> None:
        self._client: redis.Redis = redis.Redis(
            host=host,
            port=port,
            ssl=True,
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
        )

    # ------------------------------------------------------------------
    # Key helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _make_key(tool_name: str, arguments: dict) -> str:
        args_json = json.dumps(arguments, sort_keys=True, ensure_ascii=False)
        digest = hashlib.sha256(args_json.encode()).hexdigest()[:16]
        return f"mcp:{tool_name}:{digest}"

    @staticmethod
    def _resolve_ttl(tool_name: str) -> int:
        lower = tool_name.lower()
        for keyword, ttl in _TTL_MAP.items():
            if keyword in lower:
                return ttl
        return _DEFAULT_TTL

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, tool_name: str, arguments: dict) -> Any | None:
        """Return cached result or ``None`` on miss / error."""
        try:
            key = self._make_key(tool_name, arguments)
            raw = self._client.get(key)
            if raw is not None:
                logger.debug("Cache HIT: %s", key)
                return json.loads(str(raw))
            logger.debug("Cache MISS: %s", key)
        except Exception:
            logger.warning("Cache GET error for %s — failing open", tool_name, exc_info=True)
        return None

    def set(self, tool_name: str, arguments: dict, value: Any) -> None:
        """Store a result in cache. Silently ignores errors."""
        try:
            key = self._make_key(tool_name, arguments)
            ttl = self._resolve_ttl(tool_name)
            self._client.setex(key, ttl, json.dumps(value, ensure_ascii=False, default=str))
            logger.debug("Cache SET: %s (ttl=%ds)", key, ttl)
        except Exception:
            logger.warning("Cache SET error for %s — failing open", tool_name, exc_info=True)


# ------------------------------------------------------------------
# Singleton accessor
# ------------------------------------------------------------------

_instance: ValkeyCache | None = None


def get_cache() -> ValkeyCache:
    """Return the module-level ValkeyCache singleton."""
    global _instance
    if _instance is None:
        _instance = ValkeyCache()
    return _instance
