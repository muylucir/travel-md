"""Shared MCP client for AgentCore Gateway connection (AWS_IAM auth).

Uses httpx Auth flow to sign each MCP request with SigV4 for the
bedrock-agentcore service.
"""

from __future__ import annotations

import os
from datetime import timedelta

import httpx
from botocore.auth import SigV4Auth as BotoSigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.session import Session as BotocoreSession
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp import MCPClient

# streamablehttp_client defaults: timeout=30s, sse_read_timeout=300s. The
# 300s default leaks into MCPClient.stop() shutdown — workers that own a
# client end up waiting up to 5 min for the SSE read pump to drain when
# the server doesn't send a stream-close. Our Gateway calls are short
# request/response, so a tight read timeout is safe and avoids that wait.
_HTTP_TIMEOUT = timedelta(seconds=30)
_SSE_READ_TIMEOUT = timedelta(seconds=15)

GATEWAY_MCP_URL = os.getenv("GATEWAY_MCP_URL", "")
AWS_REGION = os.getenv("AWS_REGION", "ap-northeast-2")
GATEWAY_TARGET_PREFIX = os.getenv("GATEWAY_TARGET_PREFIX", "travel-tools")

_mcp_client: MCPClient | None = None
# Reused across SigV4 signers so AWS credential discovery (IMDS / env vars)
# happens once per process instead of per call.
_botocore_session: BotocoreSession | None = None


def _get_botocore_session() -> BotocoreSession:
    global _botocore_session
    if _botocore_session is None:
        _botocore_session = BotocoreSession()
    return _botocore_session


class GatewaySigV4Auth(httpx.Auth):
    """httpx Auth that adds AWS SigV4 headers to every request."""

    def __init__(self, region: str = "ap-northeast-2", service: str = "bedrock-agentcore"):
        self._region = region
        self._service = service

    def auth_flow(self, request: httpx.Request):
        body = request.content.decode() if request.content else ""
        aws_request = AWSRequest(
            method=str(request.method),
            url=str(request.url),
            headers={"Content-Type": "application/json", "Host": request.url.host},
            data=body,
        )
        credentials = _get_botocore_session().get_credentials().get_frozen_credentials()
        BotoSigV4Auth(credentials, self._service, self._region).add_auth(aws_request)

        for key, value in aws_request.headers.items():
            request.headers[key] = value

        yield request


def create_mcp_client() -> MCPClient:
    """Create and start a fresh MCPClient instance.

    Each client owns its own background thread + asyncio loop + Streamable
    HTTP session, so callers that need real concurrency (parallel graph
    workers) should each hold their own client and ``stop()`` it when done.
    """
    if not GATEWAY_MCP_URL:
        raise RuntimeError("GATEWAY_MCP_URL environment variable is not set")
    auth = GatewaySigV4Auth(region=AWS_REGION, service="bedrock-agentcore")
    client = MCPClient(
        lambda: streamablehttp_client(
            GATEWAY_MCP_URL,
            auth=auth,
            timeout=_HTTP_TIMEOUT,
            sse_read_timeout=_SSE_READ_TIMEOUT,
        )
    )
    client.start()
    return client


def get_mcp_client() -> MCPClient:
    """Lazy-init, auto-start, and return the shared MCP client.

    Used by code paths that don't need parallelism (chat agent, context
    collection, save_product). Worker nodes that need real concurrency
    should call :func:`create_mcp_client` instead.
    """
    global _mcp_client
    if _mcp_client is None:
        _mcp_client = create_mcp_client()
    return _mcp_client


def prefixed(tool_name: str) -> str:
    """Return the Gateway-prefixed tool name: 'travel-tools___tool_name'."""
    return f"{GATEWAY_TARGET_PREFIX}___{tool_name}"
