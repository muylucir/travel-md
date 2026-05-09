"""Day-Detail-phase Strands @tool wrappers.

Score-first attraction recommendation + supporting tools.
"""

from __future__ import annotations

import json
import logging
import math
from typing import Any

from strands import tool

from src.tools.graph_client import execute_query, extract_node

logger = logging.getLogger(__name__)


def _normalize_attraction_id(value: str) -> str:
    if not value:
        return ""
    if value.startswith("Attraction:"):
        return value.split(":", 1)[1]
    return value


def _parse_json_list(s: Any) -> list:
    if isinstance(s, list):
        return s
    if isinstance(s, str) and s:
        try:
            v = json.loads(s)
            return v if isinstance(v, list) else []
        except (ValueError, TypeError):
            return []
    return []


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


@tool
def recommend_attractions(
    city: str,
    theme_key: str = "",
    season_quarter: int = 0,
    exclude_ids: list | None = None,
    selected_ids: list | None = None,
    mood_keywords: list | None = None,
    arrival_airport_code: str = "",
    alpha: float = 0.40,
    beta: float = 0.25,
    gamma: float = 0.15,
    delta: float = 0.15,
    epsilon: float = 0.05,
    limit: int = 15,
    min_score: float = 0.05,
) -> str:
    """점수 함수 기반 명소 추천. **Day Detail 단계의 핵심 도구**.

    score = α * IN_THEME[theme_key].weight
          + β * BEST_IN_SEASON[Q].weight
          + γ * mood_overlap_ratio
          + δ * max(TRAVEL_TO[s, a].weight for s in selected_ids)
          + ε * ARRIVAL_FIRST_VISIT[Airport[arr_apt], a].weight

    사용자 자유 텍스트를 보고 가중치/mood_keywords 를 적절히 조절하세요.

    Args:
        city: 도시 이름 또는 코드.
        theme_key: v3 Theme.key.
        season_quarter: 1..4.
        exclude_ids: 다른 day 에 이미 배정된 명소 id (중복 방지).
        selected_ids: 같은 day 에 이미 고른 명소 id (TRAVEL_TO 가산점).
        mood_keywords: 분위기 키워드 (NIGHT_VIEW, ROMANTIC, LIVELY, ...).
        arrival_airport_code: 도착 공항 코드 (도착일 첫 명소만).
        alpha: IN_THEME 가중 (기본 0.40).
        beta: BEST_IN_SEASON 가중 (기본 0.25).
        gamma: mood_overlap 가중 (기본 0.15).
        delta: TRAVEL_TO 가중 (기본 0.15).
        epsilon: ARRIVAL_FIRST_VISIT 가중 (기본 0.05).
        limit: 기본 15.
        min_score: 기본 0.05.
    """
    if not city:
        return json.dumps({"error": "city is required"}, ensure_ascii=False)

    exclude_ids = exclude_ids or []
    selected_ids = selected_ids or []
    mood_keywords = mood_keywords or []
    exclude_norm = [_normalize_attraction_id(x) for x in exclude_ids if x]
    selected_norm = [_normalize_attraction_id(x) for x in selected_ids if x]
    mood_upper = [m.upper() for m in mood_keywords if isinstance(m, str)]

    params: dict = {
        "city": city,
        "theme_key": theme_key or None,
        "q": int(season_quarter) if season_quarter else None,
        "exclude_ids": exclude_norm or None,
        "selected_ids": selected_norm or None,
        "arr_apt": arrival_airport_code or None,
        "alpha": float(alpha),
        "beta": float(beta),
        "delta": float(delta),
        "epsilon": float(epsilon),
        "min_score": float(min_score),
        "limit_pre": int(limit) * 3,
    }

    query = """
    MATCH (a:Attraction)-[:IN_CITY]->(c:City)
    WHERE (c.name = $city OR c.code = $city)
      AND ($exclude_ids IS NULL OR NOT a.id IN $exclude_ids)
    OPTIONAL MATCH (a)-[t:IN_THEME]->(:Theme {key: $theme_key})
    OPTIONAL MATCH (a)-[s:BEST_IN_SEASON]->(:Season {quarter: $q})
    OPTIONAL MATCH (a)<-[afv:ARRIVAL_FIRST_VISIT]-(:Airport {airportCode: $arr_apt})
    OPTIONAL MATCH (sel:Attraction)-[tt:TRAVEL_TO]->(a)
      WHERE $selected_ids IS NOT NULL AND sel.id IN $selected_ids
    WITH a,
         coalesce(t.weight, 0)        AS theme_w,
         coalesce(t.rationale, '')    AS theme_reason,
         coalesce(s.weight, 0)        AS season_w,
         coalesce(afv.weight, 0)      AS afv_w,
         coalesce(max(tt.weight), 0)  AS travel_to_w
    WITH a, theme_reason, theme_w, season_w, afv_w, travel_to_w,
         ($alpha * theme_w
          + $beta * season_w
          + $epsilon * afv_w
          + $delta * travel_to_w) AS partial_score
    WHERE partial_score >= $min_score OR theme_w > 0 OR season_w > 0
    RETURN a.id AS id, a.name AS name,
           a.featureSummaryKo AS summary,
           a.recommendedStayMinutes AS stay_minutes,
           a.minStayMinutes AS min_stay_minutes,
           a.maxStayMinutes AS max_stay_minutes,
           a.type AS type,
           a.lat AS lat, a.lng AS lng,
           a.nightViewFlag AS night_view,
           a.mealFitFlag AS meal_fit,
           a.rainPlanRequired AS rain_sensitive,
           a.rainSuitability AS rain_suitability,
           a.summerHeatSuitability AS summer_suitability,
           a.winterSuitability AS winter_suitability,
           a.featureCostType AS cost_type,
           a.featureActivityLevel AS activity_level,
           a.featureWeatherSensitivity AS weather_sensitivity,
           a.featureIndoorOutdoorType AS indoor_outdoor,
           a.featureMoodTagsJson AS mood_json,
           a.featureExperienceTagsJson AS exp_json,
           a.featureLocationContextTagsJson AS loc_json,
           a.featureAgePreferenceTagsJson AS age_json,
           a.featureBestVisitTimeBandsJson AS time_json,
           a.featureCoVisitTopJson AS covisit_json,
           theme_w, season_w, afv_w, travel_to_w,
           partial_score, theme_reason
    ORDER BY partial_score DESC
    LIMIT $limit_pre
    """
    rows = execute_query(query, params)

    keyword_set = set(mood_upper)
    keyword_size = len(keyword_set) or 1
    selected_set = set(selected_norm)

    items = []
    for r in rows:
        mood_tags = _parse_json_list(r.get("mood_json"))
        exp_tags = _parse_json_list(r.get("exp_json"))
        loc_tags = _parse_json_list(r.get("loc_json"))
        age_tags = _parse_json_list(r.get("age_json"))
        time_bands = _parse_json_list(r.get("time_json"))
        covisit_top = _parse_json_list(r.get("covisit_json"))
        attr_tag_set = {
            str(x).upper() for x in mood_tags + exp_tags + loc_tags + age_tags
        }
        if keyword_set:
            inter = len(keyword_set & attr_tag_set)
            tag_overlap = inter / keyword_size
        else:
            tag_overlap = 0.0

        covisit_boost = 0.0
        if selected_set and covisit_top:
            for item in covisit_top:
                cid = item if isinstance(item, str) else (
                    item.get("id") if isinstance(item, dict) else None
                )
                if cid and cid in selected_set:
                    covisit_boost = max(
                        covisit_boost,
                        float(item.get("score", 0.5))
                        if isinstance(item, dict)
                        else 0.5,
                    )

        partial = float(r.get("partial_score") or 0)
        travel_to_w = float(r.get("travel_to_w") or 0)
        effective_travel = max(travel_to_w, covisit_boost)
        partial += float(delta) * (effective_travel - travel_to_w)

        score = partial + float(gamma) * tag_overlap
        if score < float(min_score):
            continue

        items.append(
            {
                "id": r.get("id"),
                "name": r.get("name"),
                "summary": r.get("summary"),
                "stay_minutes": r.get("stay_minutes"),
                "min_stay_minutes": r.get("min_stay_minutes"),
                "max_stay_minutes": r.get("max_stay_minutes"),
                "type": r.get("type"),
                "lat": r.get("lat"),
                "lng": r.get("lng"),
                "score": round(score, 4),
                "breakdown": {
                    "theme": round(float(r.get("theme_w") or 0), 3),
                    "season": round(float(r.get("season_w") or 0), 3),
                    "mood": round(tag_overlap, 3),
                    "travel_to": round(travel_to_w, 3),
                    "covisit": round(covisit_boost, 3),
                    "afv": round(float(r.get("afv_w") or 0), 3),
                },
                "rationale": r.get("theme_reason") or "",
                "flags": {
                    "night_view": bool(r.get("night_view")),
                    "meal_fit": bool(r.get("meal_fit")),
                    "rain_sensitive": bool(r.get("rain_sensitive")),
                },
                "suitability": {
                    "rain": r.get("rain_suitability"),
                    "summer": r.get("summer_suitability"),
                    "winter": r.get("winter_suitability"),
                    "cost_type": r.get("cost_type"),
                    "activity_level": r.get("activity_level"),
                    "weather_sensitivity": r.get("weather_sensitivity"),
                    "indoor_outdoor": r.get("indoor_outdoor"),
                },
                "tags": {
                    "mood": mood_tags,
                    "experience": exp_tags,
                    "location_context": loc_tags,
                    "age_preference": age_tags,
                    "best_visit_time": time_bands,
                },
            }
        )

    items.sort(key=lambda x: x["score"], reverse=True)
    items = items[: int(limit)]

    return json.dumps(
        {
            "city": city,
            "theme_key": theme_key,
            "season_quarter": season_quarter,
            "weights": {
                "alpha": float(alpha),
                "beta": float(beta),
                "gamma": float(gamma),
                "delta": float(delta),
                "epsilon": float(epsilon),
            },
            "mood_keywords": mood_upper,
            "attractions": items,
            "count": len(items),
        },
        ensure_ascii=False,
        default=str,
    )


@tool
def recommend_hotels(
    city: str,
    grade: str = "",
    near_attraction_id: str = "",
    alpha: float = 0.7,
    beta: float = 0.3,
    limit: int = 10,
) -> str:
    """도시별 호텔 추천. near_attraction_id 가 있으면 거리 기반 가산점.

    Args:
        city: 도시 이름 또는 코드.
        grade: 호텔 등급 필터.
        near_attraction_id: 근접 가산점 기준 명소 id.
        alpha: 도시 매칭 가중 (기본 0.7).
        beta: 거리 가중 (기본 0.3).
        limit: 기본 10.
    """
    if not city:
        return json.dumps({"error": "city is required"}, ensure_ascii=False)

    where_parts = ["(c.name = $city OR c.code = $city)"]
    params: dict = {"city": city}
    if grade:
        where_parts.append("h.grade = $grade")
        params["grade"] = grade

    rows = execute_query(
        "MATCH (h:Hotel)-[:IN_CITY]->(c:City) "
        "WHERE " + " AND ".join(where_parts) + " "
        "RETURN h.packageHotelId AS id, h.name AS name, h.grade AS grade, "
        "       h.lat AS lat, h.lng AS lng, h.address AS address, "
        "       h.location AS location, h.thumbnail AS thumbnail "
        "LIMIT 300",
        params,
    )

    pivot_lat = pivot_lng = None
    if near_attraction_id:
        norm = _normalize_attraction_id(near_attraction_id)
        attr_rows = execute_query(
            "MATCH (a:Attraction {id: $aid}) RETURN a.lat AS lat, a.lng AS lng",
            {"aid": norm},
        )
        if attr_rows:
            pivot_lat = attr_rows[0].get("lat")
            pivot_lng = attr_rows[0].get("lng")

    hotels = []
    for r in rows:
        lat = r.get("lat")
        lng = r.get("lng")
        distance_km = None
        distance_score = 0.0
        if pivot_lat is not None and pivot_lng is not None and lat is not None and lng is not None:
            try:
                distance_km = _haversine_km(
                    float(pivot_lat), float(pivot_lng), float(lat), float(lng)
                )
                distance_score = math.exp(-0.2 * distance_km)
            except (TypeError, ValueError):
                pass

        score = float(alpha) * 1.0 + float(beta) * distance_score
        hotels.append(
            {
                "id": r.get("id"),
                "name": r.get("name"),
                "grade": r.get("grade"),
                "address": r.get("address"),
                "location": r.get("location"),
                "thumbnail": r.get("thumbnail"),
                "lat": lat,
                "lng": lng,
                "score": round(score, 4),
                "breakdown": {
                    "city_match": 1.0,
                    "distance_score": round(distance_score, 3),
                    "distance_km": round(distance_km, 2) if distance_km is not None else None,
                },
            }
        )

    hotels.sort(key=lambda h: h["score"], reverse=True)
    hotels = hotels[: int(limit)]

    return json.dumps(
        {
            "city": city,
            "grade": grade,
            "near_attraction_id": near_attraction_id,
            "weights": {"alpha": float(alpha), "beta": float(beta)},
            "hotels": hotels,
            "count": len(hotels),
        },
        ensure_ascii=False,
        default=str,
    )


@tool
def get_attraction_neighbors(
    attraction_id: str,
    theme_key: str = "",
    limit: int = 10,
) -> str:
    """TRAVEL_TO 엣지로 'A 명소 다음에 자주 가는 명소'.

    일정 내 다음 명소 결정에 활용.

    Args:
        attraction_id: 기준 명소 id (raw 또는 Attraction:LJP_xxx).
        theme_key: 테마 매칭 가산점.
        limit: 기본 10.
    """
    if not attraction_id:
        return json.dumps({"error": "attraction_id is required"}, ensure_ascii=False)

    norm = _normalize_attraction_id(attraction_id)
    rows = execute_query(
        "MATCH (a:Attraction {id: $aid})-[t:TRAVEL_TO]->(next:Attraction) "
        "WHERE t.count >= 1 "
        "OPTIONAL MATCH (next)-[th:IN_THEME]->(:Theme {key: $theme_key}) "
        "RETURN next.id AS id, next.name AS name, "
        "       next.featureSummaryKo AS summary, "
        "       t.count AS count, t.weight AS travel_weight, "
        "       t.avgGapMinutes AS avg_gap, "
        "       coalesce(th.weight, 0) AS theme_match "
        "ORDER BY (coalesce(t.weight, 0) * 0.7 + coalesce(th.weight, 0) * 0.3) DESC "
        "LIMIT $limit",
        {"aid": norm, "theme_key": theme_key or None, "limit": int(limit)},
    )

    neighbors = []
    for r in rows:
        tw = float(r.get("travel_weight") or 0)
        tm = float(r.get("theme_match") or 0)
        neighbors.append(
            {
                "id": r.get("id"),
                "name": r.get("name"),
                "summary": r.get("summary"),
                "count": r.get("count"),
                "travel_weight": tw,
                "avg_gap_minutes": r.get("avg_gap"),
                "theme_match": tm,
                "score": round(tw * 0.7 + tm * 0.3, 4),
            }
        )

    return json.dumps(
        {
            "from_attraction": norm,
            "theme_key": theme_key,
            "neighbors": neighbors,
            "count": len(neighbors),
        },
        ensure_ascii=False,
        default=str,
    )


@tool
def get_attraction_detail(attraction_id: str) -> str:
    """단건 명소 상세. 일정의 short_description 채울 때 사용.

    Args:
        attraction_id: 명소 id (raw 또는 Attraction:LJP_xxx).
    """
    if not attraction_id:
        return json.dumps({"error": "attraction_id is required"}, ensure_ascii=False)

    norm = _normalize_attraction_id(attraction_id)
    rows = execute_query(
        "MATCH (a:Attraction {id: $aid}) "
        "OPTIONAL MATCH (a)-[:IN_CITY]->(c:City) "
        "RETURN a, c.name AS cityName, c.code AS cityCode",
        {"aid": norm},
    )
    if not rows:
        return json.dumps(
            {"error": f"Attraction '{norm}' not found"}, ensure_ascii=False
        )

    attr = extract_node(rows[0], "a")
    attr["cityName"] = rows[0].get("cityName")
    attr["cityCode"] = rows[0].get("cityCode")
    for k in (
        "featureMoodTagsJson",
        "featureExperienceTagsJson",
        "featureAgePreferenceTagsJson",
        "featureLocationContextTagsJson",
        "featureBestVisitTimeBandsJson",
        "featureCoVisitTopJson",
    ):
        if attr.get(k):
            attr[k] = _parse_json_list(attr[k])

    return json.dumps({"attraction": attr}, ensure_ascii=False, default=str)
