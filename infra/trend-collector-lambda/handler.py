"""Lambda handler for trend collection tools.

Routes incoming tool invocations to the appropriate collection function.
Same dispatch pattern as ota-travel-tools Lambda.
"""

from __future__ import annotations

import json
import logging
import traceback

from tools.youtube_search import youtube_search
from tools.naver_search import naver_search
from tools.google_trends import google_trends
from tools.news_crawl import news_crawl

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TOOL_REGISTRY = {
    "youtube_search": youtube_search,
    "naver_search": naver_search,
    "google_trends": google_trends,
    "news_crawl": news_crawl,
}


def handler(event, context):
    """Lambda entrypoint -- dispatches to the requested collection tool."""
    logger.info("Received event: %s", json.dumps(event, ensure_ascii=False, default=str))

    tool_name = ""
    try:
        extended_name = context.client_context.custom.get("bedrockAgentCoreToolName", "")
        if extended_name and "___" in extended_name:
            tool_name = extended_name.split("___", 1)[1]
        elif extended_name:
            tool_name = extended_name
        logger.info("Tool name from context: %s (extended: %s)", tool_name, extended_name)
    except (AttributeError, TypeError):
        tool_name = event.pop("name", "")
        logger.info("Tool name from event fallback: %s", tool_name)

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
