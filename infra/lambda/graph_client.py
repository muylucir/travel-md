"""Neptune OpenCypher client with IAM SigV4 auth for Lambda.

Uses boto3 neptunedata client over HTTPS. Stateless — no persistent
WebSocket connections, no reconnection logic needed. SigV4 signing
is handled automatically by boto3.

Each call to ``execute_query`` is also recorded in a module-level trace
buffer so the orchestrating tool can attach a _trace meta to its
response. Lambda processes one tool invocation at a time, so the buffer
is reset by ``reset_trace`` at the start of each tool function.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

import boto3

logger = logging.getLogger(__name__)

NEPTUNE_ENDPOINT = os.environ.get(
    "NEPTUNE_ENDPOINT",
    "https://db-neptune-2.cluster-cje4bejv0vps.ap-northeast-2.neptune.amazonaws.com:8182",
)

_client = None

# ─── Cypher trace buffer (per-tool invocation) ────────────────────────────
_trace: list[dict] = []


def reset_trace() -> None:
    """Clear the trace buffer at the start of a tool invocation."""
    global _trace
    _trace = []


def get_trace() -> list[dict]:
    """Return a shallow copy of the current trace buffer."""
    return list(_trace)


def get_client():
    """Return a cached boto3 neptunedata client."""
    global _client
    if _client is None:
        logger.info("Creating Neptune OpenCypher client for %s", NEPTUNE_ENDPOINT)
        _client = boto3.client(
            "neptunedata",
            endpoint_url=NEPTUNE_ENDPOINT,
            region_name=os.environ.get("AWS_REGION", "ap-northeast-2"),
        )
    return _client


def execute_query(cypher: str, params: dict | None = None) -> list[dict]:
    """Execute an OpenCypher query and return the results list."""
    kwargs: dict[str, Any] = {"openCypherQuery": cypher}
    if params:
        kwargs["parameters"] = json.dumps(params)
    started = time.perf_counter()
    response = get_client().execute_open_cypher_query(**kwargs)
    elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
    results = response.get("results", [])
    try:
        _trace.append(
            {
                "cypher": cypher,
                "params": params or {},
                "rows": len(results),
                "latency_ms": elapsed_ms,
            }
        )
    except Exception:
        pass  # never let tracing break the tool
    return results


def extract_node(row: dict, key: str) -> dict[str, Any]:
    """Extract node properties from an OpenCypher result row.

    Neptune returns nodes as:
        {"key": {"~id": "...", "~label": "...", "~properties": {...}}}
    This function normalizes that into a flat dict with 'id' and 'label' keys.
    """
    node = row.get(key, {})
    if isinstance(node, dict) and "~properties" in node:
        props = dict(node["~properties"])
        props["id"] = node.get("~id", "")
        props["label"] = node.get("~label", "")
        return props
    return dict(node) if isinstance(node, dict) else {"value": node}


def parse_json_field(value: Any) -> Any:
    """Attempt to parse a string value as JSON."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return value
    return value
