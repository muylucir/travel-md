"""Environment configuration for the Trend Collector Agent."""

import os

AWS_REGION: str = os.getenv("AWS_REGION", "ap-northeast-2")
BEDROCK_REGION: str = os.getenv("BEDROCK_REGION", "us-east-1")
SONNET_MODEL_ID: str = os.getenv("SONNET_MODEL_ID", "global.anthropic.claude-sonnet-4-6")
GATEWAY_MCP_URL: str = os.getenv("GATEWAY_MCP_URL", "")
