"""Local development FastAPI server.

Wraps the planning orchestrator in an HTTP endpoint that mimics the
AgentCore Runtime interface. Use during local development before
deploying to AgentCore.

Usage::

    uvicorn src.local_server:app --host 0.0.0.0 --port 8080 --reload
"""

from __future__ import annotations

import json
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from src.models.input import PlanningInput
from src.models.output import PlanningOutput
from src.orchestrator.graph import create_planning_graph
from src.storage.dynamodb import (
    save_product,
    get_product,
    list_products,
    delete_product,
)
from src.tools.graph_client import close_connection

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="OTA Travel Planning Agent (Local)",
    description="Local development server for the travel package planning agent.",
    version="0.1.0",
)

# CORS for Next.js dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Lazy-init graph
_graph = None


def _get_graph():
    global _graph
    if _graph is None:
        logger.info("Initializing planning graph...")
        _graph = create_planning_graph()
        logger.info("Planning graph ready")
    return _graph


@asynccontextmanager
async def _lifespan(application: FastAPI):
    yield
    close_connection()

app.router.lifespan_context = _lifespan


@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.post("/planning")
async def planning(request: PlanningInput):
    """Accept a PlanningInput and return an SSE stream of progress + result."""

    async def event_generator():
        start_time = time.time()

        try:
            yield {
                "event": "progress",
                "data": json.dumps({"step": "입력 파싱 중...", "percent": 5}, ensure_ascii=False),
            }

            graph = _get_graph()

            invocation_state = {
                "planning_input": request.model_dump(),
            }

            yield {
                "event": "progress",
                "data": json.dumps({"step": "컨텍스트 수집 중...", "percent": 15}, ensure_ascii=False),
            }

            yield {
                "event": "progress",
                "data": json.dumps({"step": "일정 생성 중...", "percent": 30}, ensure_ascii=False),
            }

            # Execute graph
            result = await graph.invoke_async(
                json.dumps(request.model_dump(), ensure_ascii=False),
                **invocation_state,
            )

            yield {
                "event": "progress",
                "data": json.dumps({"step": "검증 중...", "percent": 80}, ensure_ascii=False),
            }

            # Extract output
            planning_output_data = invocation_state.get("planning_output")
            if planning_output_data:
                output = PlanningOutput(**planning_output_data)
            else:
                # Try from graph result
                gen_result = result.results.get("generate_itinerary")
                if gen_result and gen_result.result:
                    output_text = str(gen_result.result)
                    parsed = json.loads(output_text)
                    output = PlanningOutput(**parsed)
                else:
                    raise RuntimeError("No planning output produced")

            # Save to DynamoDB
            yield {
                "event": "progress",
                "data": json.dumps({"step": "상품 저장 중...", "percent": 90}, ensure_ascii=False),
            }
            try:
                product_data = json.loads(output.model_dump_json())
                saved_code = save_product(product_data)
                logger.info("Saved product %s to DynamoDB", saved_code)
            except Exception as save_err:
                logger.warning("Failed to save product to DynamoDB: %s", save_err)

            elapsed = time.time() - start_time
            logger.info("Planning completed in %.2fs", elapsed)

            yield {
                "event": "progress",
                "data": json.dumps({"step": "완료", "percent": 100}, ensure_ascii=False),
            }

            # Validation info
            validation_result = invocation_state.get("validation_result")
            if validation_result:
                yield {
                    "event": "validation",
                    "data": json.dumps(validation_result, ensure_ascii=False, default=str),
                }

            # Final result
            yield {
                "event": "result",
                "data": output.model_dump_json(ensure_ascii=False),
            }

        except Exception as e:
            logger.exception("Planning failed")
            yield {
                "event": "error",
                "data": json.dumps({"message": str(e)}, ensure_ascii=False),
            }

    return EventSourceResponse(event_generator())


@app.post("/planning/sync")
async def planning_sync(request: PlanningInput):
    """Synchronous (non-streaming) endpoint for simpler testing."""
    try:
        graph = _get_graph()

        invocation_state = {
            "planning_input": request.model_dump(),
        }

        result = await graph.invoke_async(
            json.dumps(request.model_dump(), ensure_ascii=False),
            **invocation_state,
        )

        planning_output_data = invocation_state.get("planning_output")
        if planning_output_data:
            output = PlanningOutput(**planning_output_data)
        else:
            raise RuntimeError("No planning output produced")

        # Save to DynamoDB
        try:
            product_data = json.loads(output.model_dump_json())
            save_product(product_data)
        except Exception as save_err:
            logger.warning("Failed to save product to DynamoDB: %s", save_err)

        validation_result = invocation_state.get("validation_result")

        return {
            "output": output.model_dump(),
            "validation": validation_result,
        }

    except Exception as e:
        logger.exception("Planning sync failed")
        raise HTTPException(status_code=500, detail=str(e))


# ─── Product CRUD endpoints ───

@app.get("/products")
async def products_list(
    limit: int = Query(default=20, ge=1, le=100),
    region: Optional[str] = Query(default=None),
):
    """List AI-planned products from DynamoDB."""
    try:
        items = list_products(limit=limit, region=region)
        return {"products": items, "count": len(items)}
    except Exception as e:
        logger.exception("Failed to list products")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/products/{code}")
async def product_detail(code: str):
    """Get a single AI-planned product by product_code."""
    item = get_product(code)
    if not item:
        raise HTTPException(status_code=404, detail=f"Product {code} not found")
    return item


@app.delete("/products/{code}")
async def product_delete(code: str):
    """Delete an AI-planned product."""
    try:
        delete_product(code)
        return {"deleted": code}
    except Exception as e:
        logger.exception("Failed to delete product %s", code)
        raise HTTPException(status_code=500, detail=str(e))
