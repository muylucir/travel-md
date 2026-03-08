"""Valkey (Redis-compatible) caching layer for MCP tool results.

Caches tool responses with per-tool TTLs.  Always fails open — cache
problems never affect business logic.

Features:
- Exact-match per-tool TTL (no substring ambiguity)
- Write-tool exclusion (upsert_*, save_*, delete_*)
- Negative caching (empty results → 5 min TTL)
- Circuit-breaker reconnection (exponential backoff 30s → 300s cap)
- Pattern-based cache invalidation (SCAN + DEL)
- OpenTelemetry metrics (hit/miss/error counters, latency histogram)
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from typing import Any

from opentelemetry import metrics

from src.config import REDIS_HOST, REDIS_PORT

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# OpenTelemetry metrics (NoOp-safe if SDK is not configured)
# ---------------------------------------------------------------------------
_meter = metrics.get_meter("ota-travel.cache", "1.0.0")

_hit_counter = _meter.create_counter(
    name="cache_hit_total", unit="1", description="Number of cache hits",
)
_miss_counter = _meter.create_counter(
    name="cache_miss_total", unit="1", description="Number of cache misses",
)
_error_counter = _meter.create_counter(
    name="cache_error_total", unit="1", description="Number of cache operation errors",
)
_latency_histogram = _meter.create_histogram(
    name="cache_latency_seconds", unit="s", description="Latency of cache GET/SET operations",
)
_size_histogram = _meter.create_histogram(
    name="cache_entry_size_bytes", unit="By", description="Size of cached entries in bytes",
)

# ---------------------------------------------------------------------------
# TTL tiers (seconds)
# ---------------------------------------------------------------------------
_TTL_STATIC: int = 86_400       # 24h
_TTL_SEMI_STATIC: int = 43_200  # 12h
_TTL_DYNAMIC: int = 21_600      # 6h
_TTL_VOLATILE: int = 3_600      # 1h
_TTL_NEGATIVE: int = 300        # 5min — empty / zero-count results

_TTL_MAP: dict[str, int] = {
    # Static graph data (24h)
    "get_routes_by_region": _TTL_STATIC,
    "get_attractions_by_city": _TTL_STATIC,
    "get_hotels_by_city": _TTL_STATIC,
    "get_nearby_cities": _TTL_STATIC,
    "get_cities_by_country": _TTL_STATIC,
    # Semi-static (12h)
    "get_package": _TTL_SEMI_STATIC,
    "get_similar_packages": _TTL_SEMI_STATIC,
    # Dynamic (6h)
    "get_trends": _TTL_DYNAMIC,
    # Volatile (1h)
    "search_packages": _TTL_VOLATILE,
    "get_product": _TTL_VOLATILE,
    "list_products": _TTL_VOLATILE,
}
_DEFAULT_TTL: int = _TTL_VOLATILE

# Write tools — NEVER cache
WRITE_TOOLS: frozenset[str] = frozenset({
    "upsert_trend", "upsert_trend_spot", "link_trend_to_spot",
    "save_product", "delete_product",
})

# ---------------------------------------------------------------------------
# Reconnection backoff
# ---------------------------------------------------------------------------
_BACKOFF_BASE: float = 30.0
_BACKOFF_MAX: float = 300.0


class ValkeyCache:
    """Thin Redis/Valkey wrapper with circuit-breaker reconnection.

    On connection failure, backs off exponentially (30 s → 300 s cap) instead
    of permanently disabling.  On mid-session connection errors during
    GET/SET, resets the client so the next call triggers a fresh connection.
    Always fails open.
    """

    def __init__(self) -> None:
        self._client = None
        self._disabled_until: float = 0.0
        self._consecutive_failures: int = 0

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    def _backoff_seconds(self) -> float:
        return min(_BACKOFF_BASE * (2 ** (self._consecutive_failures - 1)), _BACKOFF_MAX)

    def _reset_client(self) -> None:
        old = self._client
        self._client = None
        if old is not None:
            try:
                old.close()
            except Exception:
                pass

    def _ensure_client(self):
        """Lazy-init Redis client.  Returns None during backoff cooldown."""
        if self._client is not None:
            return self._client

        now = time.monotonic()
        if now < self._disabled_until:
            return None

        try:
            import redis as redis_lib

            client = redis_lib.Redis(
                host=REDIS_HOST,
                port=REDIS_PORT,
                ssl=True,
                decode_responses=True,
                socket_connect_timeout=2,
                socket_timeout=2,
            )
            client.ping()
            self._client = client

            if self._consecutive_failures > 0:
                logger.info(
                    "Valkey cache reconnected after %d failure(s): %s:%s",
                    self._consecutive_failures, REDIS_HOST, REDIS_PORT,
                )
            else:
                logger.info("Valkey cache connected: %s:%s", REDIS_HOST, REDIS_PORT)

            self._consecutive_failures = 0
            self._disabled_until = 0.0
            return self._client

        except Exception as e:
            self._consecutive_failures += 1
            backoff = self._backoff_seconds()
            self._disabled_until = time.monotonic() + backoff
            logger.warning(
                "Valkey connection failed (#%d) — retry after %.0fs: %s",
                self._consecutive_failures, backoff, e,
            )
            return None

    def _handle_operation_error(self, exc: Exception, operation: str, tool_name: str) -> None:
        """Reset client on connection-class errors; log and continue otherwise."""
        import redis as redis_lib

        if isinstance(exc, (redis_lib.exceptions.ConnectionError,
                            redis_lib.exceptions.TimeoutError,
                            OSError)):
            logger.warning(
                "Cache %s connection error for %s — resetting client: %s",
                operation, tool_name, exc,
            )
            self._reset_client()
        else:
            logger.warning(
                "Cache %s error for %s — failing open: %s",
                operation, tool_name, exc, exc_info=True,
            )
        try:
            _error_counter.add(1, {"tool_name": tool_name, "operation": operation})
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Key / TTL helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _make_key(tool_name: str, arguments: dict) -> str:
        args_json = json.dumps(arguments, sort_keys=True, ensure_ascii=False)
        digest = hashlib.sha256(args_json.encode()).hexdigest()[:16]
        return f"mcp:{tool_name}:{digest}"

    @staticmethod
    def _resolve_ttl(tool_name: str) -> int:
        return _TTL_MAP.get(tool_name, _DEFAULT_TTL)

    @staticmethod
    def _is_empty_result(serialized: str) -> bool:
        """Heuristic check for empty / no-data responses."""
        if not serialized or serialized in ('""', '[]', '{}', 'null'):
            return True
        if '"count": 0' in serialized or '"count":0' in serialized:
            return True
        return False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, tool_name: str, arguments: dict) -> Any | None:
        """Return cached result or None on miss / error / disabled."""
        if tool_name in WRITE_TOOLS:
            return None
        client = self._ensure_client()
        if client is None:
            return None
        t0 = time.perf_counter()
        try:
            key = self._make_key(tool_name, arguments)
            raw = client.get(key)
            elapsed = time.perf_counter() - t0
            try:
                _latency_histogram.record(elapsed, {"tool_name": tool_name, "operation": "GET"})
            except Exception:
                pass
            if raw is not None:
                logger.info("Cache HIT: %s", key)
                try:
                    _hit_counter.add(1, {"tool_name": tool_name})
                except Exception:
                    pass
                return json.loads(str(raw))
            logger.info("Cache MISS: %s", key)
            try:
                _miss_counter.add(1, {"tool_name": tool_name})
            except Exception:
                pass
        except Exception as exc:
            self._handle_operation_error(exc, "GET", tool_name)
        return None

    def set(self, tool_name: str, arguments: dict, value: Any) -> None:
        """Store a result.  Write tools are excluded.  Empty results get short TTL."""
        if tool_name in WRITE_TOOLS:
            return
        client = self._ensure_client()
        if client is None:
            return
        t0 = time.perf_counter()
        try:
            key = self._make_key(tool_name, arguments)
            ttl = self._resolve_ttl(tool_name)
            serialized = json.dumps(value, ensure_ascii=False, default=str)
            if self._is_empty_result(serialized):
                ttl = min(ttl, _TTL_NEGATIVE)
                logger.info("Negative cache: %s (ttl=%ds)", key, ttl)
            client.setex(key, ttl, serialized)
            elapsed = time.perf_counter() - t0
            logger.info("Cache SET: %s (ttl=%ds, size=%d)", key, ttl, len(serialized))
            try:
                _latency_histogram.record(elapsed, {"tool_name": tool_name, "operation": "SET"})
                _size_histogram.record(len(serialized), {"tool_name": tool_name})
            except Exception:
                pass
        except Exception as exc:
            self._handle_operation_error(exc, "SET", tool_name)

    def delete_pattern(self, tool_name: str) -> int:
        """Delete all ``mcp:{tool_name}:*`` keys via SCAN.  Returns deleted count."""
        client = self._ensure_client()
        if client is None:
            return 0
        try:
            pattern = f"mcp:{tool_name}:*"
            deleted, cursor = 0, 0
            while True:
                cursor, keys = client.scan(cursor=cursor, match=pattern, count=100)
                if keys:
                    deleted += client.delete(*keys)
                if cursor == 0:
                    break
            logger.info("Cache delete_pattern: %s -> %d keys deleted", pattern, deleted)
            return deleted
        except Exception:
            logger.warning("Cache delete_pattern error for %s — failing open", tool_name, exc_info=True)
            return 0

    def flush_tool_cache(self) -> int:
        """Delete ALL ``mcp:*`` cached entries.  Returns deleted count."""
        client = self._ensure_client()
        if client is None:
            return 0
        try:
            deleted, cursor = 0, 0
            while True:
                cursor, keys = client.scan(cursor=cursor, match="mcp:*", count=100)
                if keys:
                    deleted += client.delete(*keys)
                if cursor == 0:
                    break
            logger.info("Cache flush_tool_cache -> %d keys deleted", deleted)
            return deleted
        except Exception:
            logger.warning("Cache flush_tool_cache error — failing open", exc_info=True)
            return 0


_instance: ValkeyCache | None = None


def get_cache() -> ValkeyCache:
    """Return the module-level ValkeyCache singleton."""
    global _instance
    if _instance is None:
        _instance = ValkeyCache()
    return _instance
