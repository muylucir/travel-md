"""Thread-safe Neptune/Gremlin connection client with IAM SigV4 auth.

Provides a shared traversal source ``g`` backed by a
``DriverRemoteConnection`` to the configured Neptune endpoint.
Each thread gets its own connection because gremlinpython 3.8 uses
aiohttp internally, and aiohttp sessions are bound to the event loop
of the thread that created them.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any
from urllib.parse import urlparse

from gremlin_python.driver.driver_remote_connection import DriverRemoteConnection
from gremlin_python.process.anonymous_traversal import traversal
from gremlin_python.process.graph_traversal import GraphTraversalSource

from src.config import GREMLIN_ENDPOINT, AWS_REGION

logger = logging.getLogger(__name__)

_local = threading.local()


def _get_neptune_headers() -> dict[str, str]:
    """Generate IAM SigV4 signed headers for Neptune WebSocket handshake."""
    try:
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
    except Exception as e:
        logger.warning("Failed to generate SigV4 headers: %s", e)
        return {}


def get_connection() -> GraphTraversalSource:
    """Return a Gremlin traversal source ``g`` for the current thread."""
    g = getattr(_local, "g", None)
    if g is not None:
        return g

    return _create_connection()


def _create_connection() -> GraphTraversalSource:
    """Create a new IAM-authenticated Gremlin connection for the current thread."""
    logger.info("Opening Gremlin connection to %s (thread=%s)", GREMLIN_ENDPOINT, threading.current_thread().name)

    headers = _get_neptune_headers()
    conn = DriverRemoteConnection(
        GREMLIN_ENDPOINT, "g",
        headers=headers,
    )
    g = traversal().withRemote(conn)
    _local.connection = conn
    _local.g = g
    return g


def reset_connection() -> None:
    """Reset the connection for the current thread (call after errors)."""
    old_conn = getattr(_local, "connection", None)
    _local.connection = None
    _local.g = None
    if old_conn is not None:
        try:
            old_conn.close()
        except Exception:
            pass


def close_connection() -> None:
    """Close Gremlin connections on all threads (best-effort)."""
    conn = getattr(_local, "connection", None)
    if conn is not None:
        logger.info("Closing Gremlin connection")
        conn.close()
        _local.connection = None
        _local.g = None


def map_to_dict(element: Any) -> dict[str, Any]:
    """Convert a Gremlin vertex/edge result map into a plain Python dict.

    Gremlin ``valueMap(true)`` returns a dict where keys are property
    names (or T.id / T.label) and values are lists. This helper
    flattens single-element lists and converts special Gremlin types.
    """
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
