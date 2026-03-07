"""YouTube Data API v3 search tool."""

from __future__ import annotations

import json
import logging
import os
from urllib.parse import quote_plus
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "")
YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3/search"


def youtube_search(region: str = "", country: str = "", city: str = "", query: str = "", max_results: int = 10) -> str:
    """Search YouTube for travel-related videos in a region, country, or city.

    Args:
        region: Region name (e.g. "규슈", "오사카"). Kept for backward compatibility.
        country: Country name (e.g. "일본", "태국").
        city: City name (e.g. "후쿠오카", "벳푸").
        query: Additional search query. Defaults to "{city} 여행" or "{country or region} 여행 트렌드".
        max_results: Max results to return (1-50).
    """
    if not YOUTUBE_API_KEY:
        return json.dumps({"error": "YOUTUBE_API_KEY not configured"}, ensure_ascii=False)

    search_query = query or (f"{city} 여행" if city else f"{country or region} 여행 트렌드")
    max_results = min(max(1, max_results), 50)

    params = (
        f"?part=snippet"
        f"&q={quote_plus(search_query)}"
        f"&type=video"
        f"&order=viewCount"
        f"&maxResults={max_results}"
        f"&relevanceLanguage=ko"
        f"&key={YOUTUBE_API_KEY}"
    )

    try:
        req = Request(YOUTUBE_API_URL + params)
        with urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())

        videos = []
        for item in data.get("items", []):
            snippet = item.get("snippet", {})
            videos.append({
                "video_id": item.get("id", {}).get("videoId", ""),
                "title": snippet.get("title", ""),
                "description": snippet.get("description", "")[:200],
                "channel": snippet.get("channelTitle", ""),
                "published_at": snippet.get("publishedAt", ""),
            })

        # Get view counts for top videos
        if videos:
            video_ids = ",".join(v["video_id"] for v in videos if v["video_id"])
            stats_params = f"?part=statistics&id={video_ids}&key={YOUTUBE_API_KEY}"
            stats_url = "https://www.googleapis.com/youtube/v3/videos" + stats_params
            stats_req = Request(stats_url)
            with urlopen(stats_req, timeout=15) as resp:
                stats_data = json.loads(resp.read().decode())

            view_map = {}
            for item in stats_data.get("items", []):
                vid = item.get("id", "")
                views = int(item.get("statistics", {}).get("viewCount", 0))
                view_map[vid] = views

            for v in videos:
                v["view_count"] = view_map.get(v["video_id"], 0)

        return json.dumps(
            {"source": "youtube", "region": region, "country": country, "city": city, "query": search_query, "videos": videos},
            ensure_ascii=False,
        )
    except Exception as e:
        logger.error("YouTube search failed: %s", e)
        return json.dumps({"error": str(e), "source": "youtube"}, ensure_ascii=False)
