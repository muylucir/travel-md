"""Google Trends tool using pytrends."""

from __future__ import annotations

import json
import logging

logger = logging.getLogger(__name__)


def google_trends(region: str = "", country: str = "", city: str = "", keywords: list[str] | None = None) -> str:
    """Fetch Google Trends data for travel keywords.

    Args:
        region: Region name (e.g. "규슈", "오사카"). Kept for backward compatibility.
        country: Country name (e.g. "일본", "태국").
        city: City name (e.g. "후쿠오카", "벳푸").
        keywords: List of keywords to check. Defaults to ["{city} 여행"] or ["{country or region} 여행"].
    """
    try:
        from pytrends.request import TrendReq
    except ImportError:
        return json.dumps({"error": "pytrends not installed"}, ensure_ascii=False)

    search_keywords = keywords or [f"{city} 여행" if city else f"{country or region} 여행"]
    # pytrends accepts max 5 keywords
    search_keywords = search_keywords[:5]

    try:
        pytrends = TrendReq(hl="ko", tz=540)  # KST = UTC+9
        pytrends.build_payload(search_keywords, timeframe="today 3-m", geo="KR")

        # Interest over time
        interest_df = pytrends.interest_over_time()
        interest_data = []
        if not interest_df.empty:
            # Get last 4 weeks of data
            recent = interest_df.tail(4)
            for date, row in recent.iterrows():
                entry = {"date": str(date.date())}
                for kw in search_keywords:
                    if kw in row:
                        entry[kw] = int(row[kw])
                interest_data.append(entry)

        # Related queries
        related = pytrends.related_queries()
        related_data = {}
        for kw in search_keywords:
            kw_data = related.get(kw, {})
            rising = kw_data.get("rising")
            top = kw_data.get("top")
            related_data[kw] = {
                "rising": rising.head(5).to_dict("records") if rising is not None and not rising.empty else [],
                "top": top.head(5).to_dict("records") if top is not None and not top.empty else [],
            }

        return json.dumps(
            {
                "source": "google_trends",
                "region": region,
                "country": country,
                "city": city,
                "keywords": search_keywords,
                "interest_over_time": interest_data,
                "related_queries": related_data,
            },
            ensure_ascii=False,
            default=str,
        )
    except Exception as e:
        logger.error("Google Trends failed: %s", e)
        return json.dumps({"error": str(e), "source": "google_trends"}, ensure_ascii=False)
