"""Shared MCP client for AgentCore Gateway connection (AWS_IAM auth).

Uses httpx Auth flow to sign each MCP request with SigV4 for the
bedrock-agentcore service.
"""

from __future__ import annotations

import os

import httpx
from botocore.auth import SigV4Auth as BotoSigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.session import Session as BotocoreSession
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp import MCPClient

GATEWAY_MCP_URL = os.getenv("GATEWAY_MCP_URL", "")
AWS_REGION = os.getenv("AWS_REGION", "ap-northeast-2")
GATEWAY_TARGET_PREFIX = os.getenv("GATEWAY_TARGET_PREFIX", "travel-tools")

_mcp_client: MCPClient | None = None


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
        session = BotocoreSession()
        credentials = session.get_credentials().get_frozen_credentials()
        BotoSigV4Auth(credentials, self._service, self._region).add_auth(aws_request)

        for key, value in aws_request.headers.items():
            request.headers[key] = value

        yield request


def get_mcp_client() -> MCPClient:
    """Lazy-init, auto-start, and return the MCP client for Gateway tools.

    The client session is started on first call and kept running for the
    lifetime of the process.  Callers do NOT need a ``with`` block.
    """
    global _mcp_client
    if _mcp_client is None:
        if not GATEWAY_MCP_URL:
            raise RuntimeError("GATEWAY_MCP_URL environment variable is not set")
        auth = GatewaySigV4Auth(region=AWS_REGION, service="bedrock-agentcore")
        _mcp_client = MCPClient(
            lambda: streamablehttp_client(GATEWAY_MCP_URL, auth=auth)
        )
        _mcp_client.start()
    return _mcp_client


def prefixed(tool_name: str) -> str:
    """Return the Gateway-prefixed tool name: 'travel-tools___tool_name'."""
    return f"{GATEWAY_TARGET_PREFIX}___{tool_name}"
