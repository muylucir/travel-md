"""Lambda handler for AgentCore Gateway MCP target.

Routes incoming tool invocations to the appropriate graph or DynamoDB
function and returns results in MCP-compatible format.

AgentCore Gateway sends:
    - event: tool arguments as a flat dict (e.g. {"destination": "오사카"})
    - context.client_context.custom["bedrockAgentCoreToolName"]:
      prefixed tool name (e.g. "travel-tools___search_packages")

Response format:
    {"content": [{"type": "text", "text": "<json_result>"}]}
"""

from __future__ import annotations

import json
import logging
import traceback

from tools.graph_tools import (
    get_package,
    search_packages,
    get_routes_by_region,
    get_attractions_by_city,
    get_hotels_by_city,
    get_trends,
    get_similar_packages,
    get_nearby_cities,
)
from tools.dynamodb_tools import (
    save_product,
    get_product,
    list_products,
    delete_product,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TOOL_REGISTRY = {
    # Graph tools (8)
    "get_package": get_package,
    "search_packages": search_packages,
    "get_routes_by_region": get_routes_by_region,
    "get_attractions_by_city": get_attractions_by_city,
    "get_hotels_by_city": get_hotels_by_city,
    "get_trends": get_trends,
    "get_similar_packages": get_similar_packages,
    "get_nearby_cities": get_nearby_cities,
    # DynamoDB tools (4)
    "save_product": save_product,
    "get_product": get_product,
    "list_products": list_products,
    "delete_product": delete_product,
}


def handler(event, context):
    """Lambda entrypoint -- dispatches to the requested tool function.

    The tool name is passed via context.client_context.custom by
    AgentCore Gateway in the format "targetName___toolName".
    The event dict contains the tool arguments directly.
    """
    logger.info("Received event: %s", json.dumps(event, ensure_ascii=False, default=str))

    # Extract tool name from Gateway context
    tool_name = ""
    try:
        extended_name = context.client_context.custom.get("bedrockAgentCoreToolName", "")
        if extended_name and "___" in extended_name:
            tool_name = extended_name.split("___", 1)[1]
        elif extended_name:
            tool_name = extended_name
        logger.info("Tool name from context: %s (extended: %s)", tool_name, extended_name)
    except (AttributeError, TypeError):
        # Fallback: check if name is in the event (direct invocation)
        tool_name = event.pop("name", "")
        logger.info("Tool name from event fallback: %s", tool_name)

    # Event IS the arguments when called via Gateway
    arguments = event

    if tool_name not in TOOL_REGISTRY:
        error_msg = json.dumps(
            {"error": f"Unknown tool: {tool_name}", "available": list(TOOL_REGISTRY.keys())},
            ensure_ascii=False,
        )
        return {"content": [{"type": "text", "text": error_msg}]}

    try:
        fn = TOOL_REGISTRY[tool_name]
        result = fn(**arguments)
        return {"content": [{"type": "text", "text": result}]}
    except Exception as e:
        logger.error("Tool %s failed: %s\n%s", tool_name, e, traceback.format_exc())
        error_msg = json.dumps({"error": str(e), "tool": tool_name}, ensure_ascii=False)
        return {"content": [{"type": "text", "text": error_msg}], "isError": True}
