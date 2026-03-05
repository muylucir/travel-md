"""4 DynamoDB CRUD tools for Lambda -- plain functions."""

from __future__ import annotations

import json
import logging
import os
import secrets
import time
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr

logger = logging.getLogger(__name__)

DYNAMODB_TABLE_NAME = os.environ.get("DYNAMODB_TABLE_NAME", "ota-planned-products")
AWS_REGION = os.environ.get("AWS_REGION", "ap-northeast-2")

_table = None


def _get_table():
    global _table
    if _table is None:
        dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
        _table = dynamodb.Table(DYNAMODB_TABLE_NAME)
    return _table


def _generate_cuid() -> str:
    """Generate a CUID-like collision-resistant ID (lowercase, URL-safe).

    Format: base36(timestamp_ms) + 8 random chars  →  ~18 chars total.
    Example: lz3k7m2p9xq4ab1c
    """
    ts = int(time.time() * 1000)
    # base36 encode timestamp
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    parts = []
    while ts:
        parts.append(chars[ts % 36])
        ts //= 36
    ts_str = "".join(reversed(parts))
    rand_str = secrets.token_hex(4)  # 8 hex chars
    return f"{ts_str}{rand_str}"


def _extract_flight_number(product: dict) -> str:
    """Extract departure flight number from product data."""
    flight = product.get("departure_flight", {})
    fn = flight.get("flight_number", "")
    if fn:
        return fn.upper().replace(" ", "")
    # fallback: try to extract from routes/itinerary
    return "NOFL"


# -------------------------------------------------------------------------
# 1. save_product
# -------------------------------------------------------------------------
def save_product(product_json: str) -> str:
    """Save a planned product to DynamoDB.

    Generates a deterministic product_code in the format:
        AI-{departure_flight_number}-{CUID}
    Example: AI-TW0301-lz3k7m2p9xq4ab1c

    Any LLM-generated product_code in the input is overwritten.

    Args:
        product_json: JSON string of the product data.
    """
    from datetime import datetime, timezone

    table = _get_table()
    product = json.loads(product_json, parse_float=Decimal)

    # Server-side overrides — don't trust LLM-generated values
    flight_number = _extract_flight_number(product)
    cuid = _generate_cuid()
    product_code = f"AI-{flight_number}-{cuid}"
    product["product_code"] = product_code
    product["generated_at"] = datetime.now(timezone.utc).isoformat()
    product["generated_by"] = "ai-agent"

    table.put_item(Item=product)
    logger.info("Saved product %s to DynamoDB", product_code)
    return json.dumps({"product_code": product_code, "status": "saved"}, ensure_ascii=False)


# -------------------------------------------------------------------------
# 2. get_product
# -------------------------------------------------------------------------
def get_product(product_code: str) -> str:
    """Get a planned product by product_code."""
    table = _get_table()
    response = table.get_item(Key={"product_code": product_code})
    item = response.get("Item")
    if item is None:
        return json.dumps({"error": f"Product '{product_code}' not found"}, ensure_ascii=False)
    return json.dumps(item, ensure_ascii=False, default=str)


# -------------------------------------------------------------------------
# 3. list_products
# -------------------------------------------------------------------------
def list_products(limit: int = 20, region: str = "") -> str:
    """List planned products. Optionally filter by region."""
    table = _get_table()
    scan_kwargs: dict = {"Limit": limit}
    if region:
        scan_kwargs["FilterExpression"] = Attr("region").eq(region)

    response = table.scan(**scan_kwargs)
    items = response.get("Items", [])
    return json.dumps({"products": items, "count": len(items)}, ensure_ascii=False, default=str)


# -------------------------------------------------------------------------
# 4. delete_product
# -------------------------------------------------------------------------
def delete_product(product_code: str) -> str:
    """Delete a planned product by product_code."""
    table = _get_table()
    table.delete_item(Key={"product_code": product_code})
    logger.info("Deleted product %s from DynamoDB", product_code)
    return json.dumps({"product_code": product_code, "status": "deleted"}, ensure_ascii=False)
