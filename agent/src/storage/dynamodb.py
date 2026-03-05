"""DynamoDB client for storing AI-planned products."""

from __future__ import annotations

import json
import logging
from decimal import Decimal
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Attr

from src.config import AWS_REGION, DYNAMODB_TABLE_NAME

logger = logging.getLogger(__name__)

_table = None


def _get_table():
    global _table
    if _table is None:
        dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
        _table = dynamodb.Table(DYNAMODB_TABLE_NAME)
    return _table


def save_product(product: dict) -> str:
    """Save a planned product to DynamoDB. Returns product_code."""
    table = _get_table()
    product_code = product.get("product_code", "")
    if not product_code:
        raise ValueError("product_code is required")

    # Convert float values to Decimal for DynamoDB compatibility
    product = json.loads(json.dumps(product), parse_float=Decimal)
    table.put_item(Item=product)
    logger.info("Saved product %s to DynamoDB", product_code)
    return product_code


def get_product(product_code: str) -> Optional[dict]:
    """Get a planned product by product_code."""
    table = _get_table()
    response = table.get_item(Key={"product_code": product_code})
    return response.get("Item")


def list_products(limit: int = 20, region: Optional[str] = None) -> list[dict]:
    """List planned products. Optionally filter by region."""
    table = _get_table()

    scan_kwargs: dict = {"Limit": limit}
    if region:
        scan_kwargs["FilterExpression"] = Attr("region").eq(region)

    response = table.scan(**scan_kwargs)
    items = response.get("Items", [])
    return items


def delete_product(product_code: str) -> None:
    """Delete a planned product."""
    table = _get_table()
    table.delete_item(Key={"product_code": product_code})
    logger.info("Deleted product %s from DynamoDB", product_code)
