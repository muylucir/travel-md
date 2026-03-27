"""Neptune OpenCypher client with IAM SigV4 auth for Lambda.

Uses boto3 neptunedata client over HTTPS. Stateless — no persistent
WebSocket connections, no reconnection logic needed. SigV4 signing
is handled automatically by boto3.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3

logger = logging.getLogger(__name__)

NEPTUNE_ENDPOINT = os.environ.get(
    "NEPTUNE_ENDPOINT",
    "https://REDACTED_NEPTUNE_HOST:8182",
)

_client = None


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
    response = get_client().execute_open_cypher_query(**kwargs)
    return response.get("results", [])


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
