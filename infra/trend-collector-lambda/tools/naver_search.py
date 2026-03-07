"""Naver Search API tool (Blog + Cafe)."""

from __future__ import annotations

import json
import logging
import os
from urllib.parse import quote_plus
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

NAVER_CLIENT_ID = os.environ.get("NAVER_CLIENT_ID", "")
NAVER_CLIENT_SECRET = os.environ.get("NAVER_CLIENT_SECRET", "")
NAVER_BLOG_URL = "https://openapi.naver.com/v1/search/blog.json"
NAVER_CAFE_URL = "https://openapi.naver.com/v1/search/cafearticle.json"


def _naver_request(url: str, query: str, display: int = 10) -> dict:
    """Make an authenticated Naver API request."""
    params = f"?query={quote_plus(query)}&display={display}&sort=sim"
    req = Request(url + params)
    req.add_header("X-Naver-Client-Id", NAVER_CLIENT_ID)
    req.add_header("X-Naver-Client-Secret", NAVER_CLIENT_SECRET)

    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def naver_search(region: str = "", country: str = "", city: str = "", query: str = "", max_results: int = 10) -> str:
    """Search Naver Blog and Cafe for travel content.

    Args:
        region: Region name (e.g. "규슈", "오사카"). Kept for backward compatibility.
        country: Country name (e.g. "일본", "태국").
        city: City name (e.g. "후쿠오카", "벳푸").
        query: Additional search query. Defaults to "{city} 여행" or "{country or region} 여행 트렌드".
        max_results: Max results per source (blog/cafe).
    """
    if not NAVER_CLIENT_ID or not NAVER_CLIENT_SECRET:
        return json.dumps({"error": "Naver API credentials not configured"}, ensure_ascii=False)

    search_query = query or (f"{city} 여행" if city else f"{country or region} 여행 트렌드")
    display = min(max(1, max_results), 100)

    results = {"source": "naver", "region": region, "country": country, "city": city, "query": search_query, "blogs": [], "cafes": []}

    try:
        blog_data = _naver_request(NAVER_BLOG_URL, search_query, display)
        for item in blog_data.get("items", []):
            # Strip HTML tags from title/description
            title = item.get("title", "").replace("<b>", "").replace("</b>", "")
            desc = item.get("description", "").replace("<b>", "").replace("</b>", "")
            results["blogs"].append({
                "title": title,
                "description": desc[:200],
                "link": item.get("link", ""),
                "blogger_name": item.get("bloggername", ""),
                "post_date": item.get("postdate", ""),
            })
    except Exception as e:
        logger.error("Naver blog search failed: %s", e)
        results["blog_error"] = str(e)

    try:
        cafe_data = _naver_request(NAVER_CAFE_URL, search_query, display)
        for item in cafe_data.get("items", []):
            title = item.get("title", "").replace("<b>", "").replace("</b>", "")
            desc = item.get("description", "").replace("<b>", "").replace("</b>", "")
            results["cafes"].append({
                "title": title,
                "description": desc[:200],
                "link": item.get("link", ""),
                "cafe_name": item.get("cafename", ""),
            })
    except Exception as e:
        logger.error("Naver cafe search failed: %s", e)
        results["cafe_error"] = str(e)

    return json.dumps(results, ensure_ascii=False)
