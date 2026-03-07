"""News crawl tool — Naver News API + Google News RSS."""

from __future__ import annotations

import json
import logging
import os
import re
import xml.etree.ElementTree as ET
from urllib.parse import quote_plus
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

NAVER_CLIENT_ID = os.environ.get("NAVER_CLIENT_ID", "")
NAVER_CLIENT_SECRET = os.environ.get("NAVER_CLIENT_SECRET", "")
NAVER_NEWS_URL = "https://openapi.naver.com/v1/search/news.json"
GOOGLE_NEWS_RSS = "https://news.google.com/rss/search"


def _strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text)


def _fetch_naver_news(query: str, display: int = 10) -> list[dict]:
    """Fetch news from Naver News API."""
    if not NAVER_CLIENT_ID or not NAVER_CLIENT_SECRET:
        return []

    params = f"?query={quote_plus(query)}&display={display}&sort=date"
    req = Request(NAVER_NEWS_URL + params)
    req.add_header("X-Naver-Client-Id", NAVER_CLIENT_ID)
    req.add_header("X-Naver-Client-Secret", NAVER_CLIENT_SECRET)

    with urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())

    articles = []
    for item in data.get("items", []):
        articles.append({
            "title": _strip_html(item.get("title", "")),
            "description": _strip_html(item.get("description", ""))[:200],
            "link": item.get("originallink", item.get("link", "")),
            "pub_date": item.get("pubDate", ""),
            "source": "naver_news",
        })
    return articles


def _fetch_google_news_rss(query: str, max_results: int = 10) -> list[dict]:
    """Fetch news from Google News RSS."""
    url = f"{GOOGLE_NEWS_RSS}?q={quote_plus(query)}&hl=ko&gl=KR&ceid=KR:ko"
    req = Request(url)
    req.add_header("User-Agent", "Mozilla/5.0")

    with urlopen(req, timeout=15) as resp:
        xml_data = resp.read().decode()

    articles = []
    try:
        root = ET.fromstring(xml_data)
        for item in root.findall(".//item")[:max_results]:
            title = item.findtext("title", "")
            link = item.findtext("link", "")
            pub_date = item.findtext("pubDate", "")
            # Google News RSS source is in the title after " - "
            source_name = ""
            if " - " in title:
                parts = title.rsplit(" - ", 1)
                title = parts[0]
                source_name = parts[1] if len(parts) > 1 else ""

            articles.append({
                "title": title,
                "description": "",
                "link": link,
                "pub_date": pub_date,
                "source": f"google_news ({source_name})" if source_name else "google_news",
            })
    except ET.ParseError as e:
        logger.error("Failed to parse Google News RSS: %s", e)

    return articles


def news_crawl(region: str = "", country: str = "", city: str = "", query: str = "", max_results: int = 10) -> str:
    """Crawl news articles about a travel region, country, or city.

    Args:
        region: Region name (e.g. "규슈", "오사카"). Kept for backward compatibility.
        country: Country name (e.g. "일본", "태국").
        city: City name (e.g. "후쿠오카", "벳푸").
        query: Additional search query. Defaults to "{city} 여행" or "{country or region} 여행 트렌드".
        max_results: Max results per source.
    """
    search_query = query or (f"{city} 여행" if city else f"{country or region} 여행 트렌드")
    max_results = min(max(1, max_results), 50)

    all_articles = []
    errors = []

    try:
        naver_articles = _fetch_naver_news(search_query, max_results)
        all_articles.extend(naver_articles)
    except Exception as e:
        logger.error("Naver news crawl failed: %s", e)
        errors.append(f"naver_news: {e}")

    try:
        google_articles = _fetch_google_news_rss(search_query, max_results)
        all_articles.extend(google_articles)
    except Exception as e:
        logger.error("Google news crawl failed: %s", e)
        errors.append(f"google_news: {e}")

    result = {
        "source": "news",
        "region": region,
        "country": country,
        "city": city,
        "query": search_query,
        "articles": all_articles,
        "total": len(all_articles),
    }
    if errors:
        result["errors"] = errors

    return json.dumps(result, ensure_ascii=False)
