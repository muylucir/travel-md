"""Neptune/Gremlin connection client with IAM SigV4 auth for Lambda.

Provides a module-level traversal source ``g`` that is reused across
warm invocations. Lambda runs a single thread per invocation so no
thread-local storage is needed.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any
from urllib.parse import urlparse

from gremlin_python.driver.driver_remote_connection import DriverRemoteConnection
from gremlin_python.process.anonymous_traversal import traversal
from gremlin_python.process.graph_traversal import GraphTraversalSource

logger = logging.getLogger(__name__)

GREMLIN_ENDPOINT = os.environ.get(
    "GREMLIN_ENDPOINT",
    "wss://REDACTED_NEPTUNE_HOST:8182/gremlin",
)
AWS_REGION = os.environ.get("AWS_REGION", "ap-northeast-2")

_connection: DriverRemoteConnection | None = None
_g: GraphTraversalSource | None = None


def _get_neptune_headers() -> dict[str, str]:
    """Generate IAM SigV4 signed headers for Neptune WebSocket handshake."""
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    from botocore.session import Session

    parsed = urlparse(GREMLIN_ENDPOINT)
    host = parsed.hostname
    port = parsed.port or 8182

    session = Session()
    credentials = session.get_credentials().get_frozen_credentials()

    request = AWSRequest(
        method="GET",
        url=f"https://{host}:{port}/gremlin",
        headers={"Host": f"{host}:{port}"},
    )
    SigV4Auth(credentials, "neptune-db", AWS_REGION).add_auth(request)

    return dict(request.headers)


def get_connection() -> GraphTraversalSource:
    """Return a Gremlin traversal source ``g``, reused across warm invocations."""
    global _connection, _g
    if _g is not None:
        return _g

    logger.info("Opening Gremlin connection to %s", GREMLIN_ENDPOINT)
    headers = _get_neptune_headers()
    _connection = DriverRemoteConnection(
        GREMLIN_ENDPOINT, "g",
        headers=headers,
    )
    _g = traversal().withRemote(_connection)
    return _g


def reset_connection() -> None:
    """Reset the connection (call after errors)."""
    global _connection, _g
    old = _connection
    _connection = None
    _g = None
    if old is not None:
        try:
            old.close()
        except Exception:
            pass


def map_to_dict(element: Any) -> dict[str, Any]:
    """Convert a Gremlin vertex/edge result map into a plain Python dict."""
    if isinstance(element, dict):
        result: dict[str, Any] = {}
        for key, value in element.items():
            str_key = str(key) if not isinstance(key, str) else key
            if str_key.startswith("T."):
                str_key = str_key[2:]
            if isinstance(value, list) and len(value) == 1:
                result[str_key] = value[0]
            else:
                result[str_key] = value
        return result
    return {"value": element}


def parse_json_field(value: Any) -> Any:
    """Attempt to parse a string value as JSON."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return value
    return value
