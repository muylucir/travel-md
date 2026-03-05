"""Environment configuration for the OTA Travel Agent."""

import os


# Neptune / Gremlin
GREMLIN_ENDPOINT: str = os.getenv(
    "GREMLIN_ENDPOINT",
    "wss://REDACTED_NEPTUNE_HOST:8182/gremlin",
)

# ElastiCache / Valkey (Redis-compatible)
REDIS_HOST: str = os.getenv(
    "REDIS_HOST",
    "REDACTED_VALKEY_HOST",
)
REDIS_PORT: int = int(os.getenv("REDIS_PORT", "6379"))

# Amazon Bedrock
BEDROCK_REGION: str = os.getenv("BEDROCK_REGION", "us-east-1")
AWS_REGION: str = os.getenv("AWS_REGION", "ap-northeast-2")

# DynamoDB
DYNAMODB_TABLE_NAME: str = os.getenv("DYNAMODB_TABLE_NAME", "ota-planned-products")

# Model IDs
OPUS_MODEL_ID: str = os.getenv("OPUS_MODEL_ID", "global.anthropic.claude-opus-4-6-v1")
SONNET_MODEL_ID: str = os.getenv("SONNET_MODEL_ID", "global.anthropic.claude-sonnet-4-6")

# Orchestrator limits
MAX_RETRIES: int = 3
WORKFLOW_TIMEOUT_S: int = 120
GRAPH_QUERY_TIMEOUT_S: int = 10
LLM_GENERATION_TIMEOUT_S: int = 60
VALIDATION_TIMEOUT_S: int = 5
