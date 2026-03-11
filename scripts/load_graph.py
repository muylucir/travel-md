"""크롤링 JSON -> Gremlin Graph DB 적재 스크립트.

로컬 Gremlin Server 또는 Amazon Neptune에 데이터를 적재합니다.

사용법:
  # 로컬 Gremlin Server
  python3 load_graph.py --data-dir ./data

  # Amazon Neptune
  python3 load_graph.py --data-dir ./data --endpoint wss://your-cluster.neptune.amazonaws.com:8182/gremlin

  # 기존 데이터 초기화 후 적재 (Trend/TrendSpot 보존)
  python3 load_graph.py --data-dir ./data --drop-all

  # Dry-run (접속 없이 통계만 출력)
  python3 load_graph.py --data-dir ./data --dry-run
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import time
from collections import Counter
from typing import Any

from gremlin_python.driver.driver_remote_connection import DriverRemoteConnection
from gremlin_python.driver.protocol import GremlinServerWSProtocol
from gremlin_python.process.anonymous_traversal import traversal
from gremlin_python.process.graph_traversal import GraphTraversalSource, __
from gremlin_python.process.traversal import Cardinality


def create_neptune_connection(endpoint: str) -> DriverRemoteConnection:
    """Neptune SigV4 인증 또는 로컬 Gremlin Server 접속."""
    if "neptune.amazonaws.com" in endpoint:
        # Neptune -- SigV4 WebSocket 핸드셰이크 헤더 생성
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        from botocore.session import Session as BotocoreSession
        from urllib.parse import urlparse

        parsed = urlparse(endpoint)
        host = parsed.hostname
        region = _extract_region(host)

        session = BotocoreSession()
        credentials = session.get_credentials().get_frozen_credentials()

        # SigV4 서명 생성
        request = AWSRequest(method="GET", url=f"https://{host}:8182/gremlin", headers={"Host": host})
        SigV4Auth(credentials, "neptune-db", region).add_auth(request)

        # 서명된 헤더 추출
        signed_headers = dict(request.headers)

        return DriverRemoteConnection(
            endpoint, "g",
            headers=signed_headers,
        )
    else:
        # 로컬 Gremlin Server
        return DriverRemoteConnection(endpoint, "g")


def _extract_region(hostname: str) -> str:
    """Neptune 호스트명에서 리전 추출. 예: xxx.ap-northeast-2.neptune.amazonaws.com -> ap-northeast-2"""
    parts = hostname.split(".")
    for i, p in enumerate(parts):
        if p == "neptune":
            return parts[i - 1]
    return "us-east-1"  # fallback


# ============================================================
# 설정
# ============================================================

DEFAULT_ENDPOINT = "ws://localhost:8182/gremlin"

# 해시태그 -> 테마 자동 분류
THEME_KEYWORDS = {
    "가족여행": ["가족", "아이와", "키즈", "아동동반", "가족여행"],
    "힐링": ["힐링", "휴양", "스파", "힐링휴양", "여유"],
    "온천": ["온천", "노천탕", "료칸", "온센"],
    "허니문": ["허니문", "커플", "로맨틱", "신혼"],
    "식도락": ["맛집", "식도락", "미식", "미쉐린", "미식여행"],
    "액티비티": ["액티비티", "체험", "스노클", "다이빙", "서핑"],
    "쇼핑": ["쇼핑", "아울렛", "면세점"],
    "문화탐방": ["문화", "역사", "신사", "사찰", "유적"],
    "자연": ["자연", "트레킹", "산책", "국립공원", "하이킹"],
    "효도여행": ["효도", "부모님", "어르신"],
    "시즌이벤트": ["벚꽃", "단풍", "축제", "겨울", "여름"],
    "골프": ["골프"],
}

# 관광지 카테고리 추정
ATTRACTION_CATEGORY_KEYWORDS = {
    "신사": ["신사", "사찰", "절", "텐만구"],
    "자연": ["산", "호수", "공원", "폭포", "녹나무", "해변", "온천", "계곡", "바다"],
    "문화": ["도서관", "박물관", "미술관", "성", "궁전", "마을"],
    "체험": ["체험", "공방", "시장"],
    "테마파크": ["유니버설", "디즈니", "테마파크", "놀이공원", "라라포트"],
    "쇼핑": ["쇼핑", "아울렛", "면세점", "시장", "몰"],
    "맛집": ["맛집", "식당", "레스토랑", "카페", "정식"],
}

# 안내/공지 키워드 (top-level attractions 필터)
NOTICE_KEYWORDS = ["안내", "조건", "서류", "준비", "절차", "필요서류"]


# ============================================================
# 유틸리티
# ============================================================

DEPARTURE_CITIES = {"인천", "김포", "부산", "대구", "제주", "청주", "무안", "양양"}

# destination_cities 노이즈 필터 (통화코드, 항공사코드, 공항코드 등)
DESTINATION_NOISE = {"USD", "THB", "EUR", "CZK", "HUF", "PHP", "CHF", "GBP", "JPY",
                     "LH", "TDAC", "RATP", "CDG", "ORLY"}


def detect_season(data: dict) -> list[str]:
    """출발편 날짜(YYYY.MM.DD)에서 시즌을 감지한다."""
    dep_flight = data.get("departure_flight")
    if not isinstance(dep_flight, dict):
        return []
    dep_date = dep_flight.get("date") or ""
    m = re.search(r"(\d{4})\.(\d{2})\.(\d{2})", dep_date)
    if not m:
        return []
    month = int(m.group(2))
    season_map = {
        3: "봄", 4: "봄", 5: "봄",
        6: "여름", 7: "여름", 8: "여름",
        9: "가을", 10: "가을", 11: "가을",
        12: "겨울", 1: "겨울", 2: "겨울",
    }
    return [season_map[month]]


def safe_str(val: Any) -> str | None:
    """None이 아니면 문자열로 변환."""
    return str(val).strip() if val else None


def classify_themes(hashtags: list[str], highlights: list[str], product_tags: list[str]) -> list[str]:
    """해시태그+핵심포인트+태그에서 테마를 자동 분류."""
    text = " ".join(hashtags + highlights + product_tags).lower()
    themes = []
    for theme, keywords in THEME_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            themes.append(theme)
    return themes if themes else ["관광"]  # 기본 테마


def classify_attraction(name: str, desc: str) -> str:
    """관광지 카테고리 추정."""
    text = f"{name} {desc}".lower()
    for category, keywords in ATTRACTION_CATEGORY_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            return category
    return "관광지"


# ============================================================
# 도시/관광지 매칭 헬퍼
# ============================================================

def ensure_city(g: GraphTraversalSource, city_name: str, country: str | None,
                region: str | None, stats: Counter, extra_props: dict | None = None) -> bool:
    """Create/update City node + IN_REGION edge. Returns False if departure city."""
    if city_name in DEPARTURE_CITIES:
        return False
    props = {"country": country or "", "region": region or ""}
    if extra_props:
        props.update(extra_props)
    props = {k: v for k, v in props.items() if v}
    upsert_vertex(g, "City", "name", city_name, props)
    stats["City"] += 1
    if region:
        upsert_edge(g, "City", "name", city_name, "IN_REGION", "Region", "name", region)
    return True


def _match_attraction_to_cities(attr_name: str, day_cities: list[str], all_cities: list[str]) -> list[str]:
    """Match attraction to city by checking if city name appears in attraction name.
    Returns list of matched city names. Falls back to first city of the day."""
    # Sort by length desc to match longest first (e.g., "체스키 크룸로프" before "체스키")
    candidates = sorted(day_cities, key=len, reverse=True)
    for city in candidates:
        if city in attr_name:
            return [city]
    # Fallback: first city of the day
    if day_cities:
        return [day_cities[0]]
    return []


def _strip_trailing_city(attr_name: str, cities: list[str]) -> str:
    """Remove trailing city name suffix from attraction name (crawler artifact)."""
    for city in sorted(cities, key=len, reverse=True):
        if attr_name.endswith(" " + city):
            return attr_name[:-len(city) - 1].strip()
    return attr_name


# ============================================================
# Gremlin 적재 함수
# ============================================================

def upsert_vertex(g: GraphTraversalSource, label: str, pk_key: str, pk_val: str, props: dict) -> None:
    """노드가 없으면 생성, 있으면 속성 업데이트 (MERGE 패턴)."""
    t = g.V().has(label, pk_key, pk_val).fold().coalesce(
        __.unfold(),
        __.addV(label).property(pk_key, pk_val)
    )
    for k, v in props.items():
        if v is not None:
            if isinstance(v, list):
                # 리스트는 multi-value property
                for item in v:
                    t = t.property(Cardinality.set_, k, str(item))
            elif isinstance(v, dict):
                t = t.property(k, json.dumps(v, ensure_ascii=False))
            else:
                t = t.property(k, v)
    t.next()


def upsert_edge(g: GraphTraversalSource, from_label: str, from_pk: str, from_val: str,
                edge_label: str, to_label: str, to_pk: str, to_val: str,
                props: dict | None = None) -> None:
    """엣지가 없으면 생성 (중복 방지). 양쪽 노드가 없으면 스킵."""
    if not from_val or not to_val:
        return

    # 양쪽 노드 존재 확인
    from_exists = g.V().has(from_label, from_pk, from_val).count().next()
    to_exists = g.V().has(to_label, to_pk, to_val).count().next()
    if from_exists == 0 or to_exists == 0:
        return

    # 이미 같은 엣지가 있는지 확인
    existing = g.V().has(from_label, from_pk, from_val).outE(edge_label).where(
        __.inV().has(to_label, to_pk, to_val)
    ).count().next()
    if existing > 0:
        return

    t = g.V().has(from_label, from_pk, from_val).addE(edge_label).to(
        __.V().has(to_label, to_pk, to_val)
    )
    if props:
        for k, v in props.items():
            if v is not None:
                t = t.property(k, v)
    try:
        t.next()
    except Exception as e:
        # Neptune에서 간헐적으로 발생하는 null 참조 에러 무시
        if "null or non-existent" in str(e):
            pass
        else:
            raise


# ============================================================
# 메인 적재 로직
# ============================================================

def load_package(g: GraphTraversalSource, data: dict, stats: Counter) -> None:
    """단일 패키지 JSON을 Graph에 적재."""
    code = data.get("product_code")
    if not code:
        return

    country = data.get("country")
    region = data.get("region")

    # ── 1. Package 노드 ──
    pricing = data.get("pricing") or {}
    guide_fee = data.get("guide_fee")
    pkg_props = {
        "name": data.get("package_name"),
        "description": data.get("description"),
        "price": pricing.get("adult_price"),
        "child_price": pricing.get("child_price"),
        "infant_price": pricing.get("infant_price"),
        "fuel_surcharge": pricing.get("fuel_surcharge"),
        "nights": data.get("nights"),
        "days": data.get("days"),
        "duration": data.get("duration"),
        "rating": data.get("rating"),
        "review_count": data.get("review_count"),
        "product_line": data.get("product_line"),
        "country": country,
        "region": region,
        "source_url": data.get("source_url"),
        # 패키지 특성
        "shopping_count": data.get("shopping_count"),
        "guide_fee_amount": guide_fee.get("amount") if guide_fee else None,
        "guide_fee_currency": guide_fee.get("currency") if guide_fee else None,
        "single_room_surcharge": pricing.get("single_room_surcharge"),
        "hashtags": data.get("hashtags"),
        "highlights": data.get("highlights"),
        "promotions": data.get("promotions"),
        "product_tags": data.get("product_tags"),
        "season": json.dumps(detect_season(data), ensure_ascii=False),
    }
    # None 제거
    pkg_props = {k: v for k, v in pkg_props.items() if v is not None}
    upsert_vertex(g, "Package", "code", code, pkg_props)
    stats["Package"] += 1

    # ── 2. Country 노드 + IN_COUNTRY 엣지 ──
    if country:
        upsert_vertex(g, "Country", "name", country, {})
        upsert_edge(g, "Package", "code", code, "IN_COUNTRY", "Country", "name", country)

    # ── 3. Region 노드 + BELONGS_TO 엣지 ──
    if region:
        upsert_vertex(g, "Region", "name", region, {"country": country or ""})
        if country:
            upsert_edge(g, "Region", "name", region, "BELONGS_TO", "Country", "name", country)

    # ── 4. City 노드 수집 ──
    # Build a master set of all valid city names for this package
    city_list = data.get("city_list") or []
    all_city_names: set[str] = set()

    # 4a. destination_cities (richest metadata: code, timezone, voltage)
    for city_info in (data.get("destination_cities") or []):
        city_name = city_info.get("name")
        city_code = city_info.get("code", "")
        if not city_name:
            continue
        if city_code in DESTINATION_NOISE or city_name in DEPARTURE_CITIES:
            continue
        # Cross-reference: only accept if also in city_list (when city_list exists)
        if city_list and city_name not in city_list:
            continue
        extra_props = {
            "code": city_info.get("code"),
            "timezone": city_info.get("timezone"),
            "voltage": city_info.get("voltage"),
        }
        extra_props = {k: v for k, v in extra_props.items() if v}
        ensure_city(g, city_name, country, region, stats, extra_props)
        all_city_names.add(city_name)

    # 4b. city_list (보강)
    for city_name in city_list:
        if city_name in DEPARTURE_CITIES:
            continue
        ensure_city(g, city_name, country, region, stats)
        all_city_names.add(city_name)

    # 4c. itinerary cities + VISITS 엣지
    itinerary = data.get("itinerary") or []
    for day_info in itinerary:
        day = day_info.get("day", 0)
        cities_str = day_info.get("cities") or ""
        for order, city_name in enumerate([c.strip() for c in cities_str.split(",") if c.strip()], 1):
            if city_name in DEPARTURE_CITIES:
                continue
            ensure_city(g, city_name, country, region, stats)
            all_city_names.add(city_name)
            upsert_edge(g, "Package", "code", code, "VISITS", "City", "name", city_name,
                        {"day": day, "order": order})

    # 4d. Fallback: VISITS from city_list when itinerary is empty
    if not itinerary:
        for city_name in city_list:
            if city_name in DEPARTURE_CITIES:
                continue
            ensure_city(g, city_name, country, region, stats)
            upsert_edge(g, "Package", "code", code, "VISITS", "City", "name", city_name,
                        {"layer": 1, "weight": 0.95})

    # ── 5. Attraction 노드 + INCLUDES 엣지 ──

    # 5a. From itinerary (primary - real attractions)
    for day_info in itinerary:
        day = day_info.get("day", 0)
        day_cities_str = day_info.get("cities") or ""
        day_cities = [c.strip() for c in day_cities_str.split(",")
                      if c.strip() and c.strip() not in DEPARTURE_CITIES]

        for order, attr_name in enumerate(day_info.get("attractions") or [], 1):
            # Filter junk
            if not attr_name or len(attr_name) <= 2:
                continue
            # Skip if it's just a city name
            if attr_name in all_city_names:
                continue
            # Strip trailing city name suffix (crawler artifact)
            attr_name_clean = _strip_trailing_city(attr_name, day_cities + list(all_city_names))

            upsert_vertex(g, "Attraction", "name", attr_name_clean,
                          {"category": classify_attraction(attr_name_clean, "")})
            stats["Attraction"] += 1
            upsert_edge(g, "Package", "code", code, "INCLUDES", "Attraction", "name", attr_name_clean,
                        {"day": day, "order": order})

            # City --HAS_ATTRACTION--> Attraction (smart matching)
            matched = _match_attraction_to_cities(attr_name_clean, day_cities, list(all_city_names))
            for city in matched:
                upsert_edge(g, "City", "name", city, "HAS_ATTRACTION", "Attraction", "name", attr_name_clean)

    # 5b. From top-level attractions[] (supplementary - descriptions)
    for attr in (data.get("attractions") or []):
        attr_name = attr.get("name")
        if not attr_name or any(kw in attr_name for kw in NOTICE_KEYWORDS):
            continue
        desc = attr.get("short_description") or ""
        category = classify_attraction(attr_name, desc)
        upsert_vertex(g, "Attraction", "name", attr_name, {"description": desc, "category": category})
        stats["Attraction"] += 1
        upsert_edge(g, "Package", "code", code, "INCLUDES", "Attraction", "name", attr_name,
                    {"layer": 3, "weight": 0.50})

    # ── 6. Hotel 노드 + INCLUDES_HOTEL 엣지 + City --HAS_HOTEL--> Hotel ──
    for hotel in (data.get("hotels") or []):
        hotel_id = hotel.get("name_en") or hotel.get("name_ko")
        if not hotel_id:
            continue
        hotel_props = {
            "name_ko": hotel.get("name_ko"),
            "name_en": hotel.get("name_en"),
            "description": hotel.get("description"),
            "room_type": hotel.get("room_type"),
            "amenities": hotel.get("amenities"),
            "onsen_info": hotel.get("onsen_info"),
            "has_onsen": bool(hotel.get("onsen_info")),
        }
        hotel_props = {k: v for k, v in hotel_props.items() if v is not None}
        upsert_vertex(g, "Hotel", "name", hotel_id, hotel_props)
        stats["Hotel"] += 1
        upsert_edge(g, "Package", "code", code, "INCLUDES_HOTEL", "Hotel", "name", hotel_id,
                     {"layer": 2, "weight": 0.70})

        # Link hotel to city by matching city name in hotel name or description
        hotel_text = f"{hotel.get('name_ko', '')} {hotel.get('name_en', '')} {hotel.get('description', '')}"
        for city_name in all_city_names:
            if city_name in hotel_text and len(city_name) >= 2:
                upsert_edge(g, "City", "name", city_name, "HAS_HOTEL", "Hotel", "name", hotel_id)
                break  # Link to first matching city only

    # ── 7. Airline 노드 + USES 엣지 ──
    airline = data.get("airline")
    airline_type = data.get("airline_type")
    if airline:
        upsert_vertex(g, "Airline", "name", airline, {"type": airline_type or "LCC"})
        stats["Airline"] += 1
        upsert_edge(g, "Package", "code", code, "USES", "Airline", "name", airline)

    # ── 8. Route 노드 + DEPARTS_ON 엣지 + Route --TO--> City + Route --OPERATES--> Airline ──
    for flight_key, route_type in [("departure_flight", "outbound"), ("return_flight", "return")]:
        flight = data.get(flight_key)
        if not flight or not flight.get("flight_number"):
            continue
        flight_no = flight["flight_number"]
        route_props = {
            "flight_number": flight_no,
            "departure_time": flight.get("departure_time"),
            "arrival_time": flight.get("arrival_time"),
            "duration": flight.get("duration"),
            "date": flight.get("date"),
            "airline": airline,
            "airline_type": airline_type,
        }
        route_props = {k: v for k, v in route_props.items() if v is not None}
        upsert_vertex(g, "Route", "flight_number", flight_no, route_props)
        stats["Route"] += 1
        upsert_edge(g, "Package", "code", code, "DEPARTS_ON", "Route", "flight_number", flight_no,
                     {"type": route_type})
        if airline:
            upsert_edge(g, "Route", "flight_number", flight_no, "OPERATES", "Airline", "name", airline)

        # Route --TO--> City
        # Filter city_list to non-departure cities for destination linking
        dest_cities = [c for c in city_list if c not in DEPARTURE_CITIES]
        if route_type == "outbound" and dest_cities:
            # Outbound goes TO first destination city
            upsert_edge(g, "Route", "flight_number", flight_no, "TO", "City", "name", dest_cities[0])
        elif route_type == "return" and dest_cities:
            # Return goes FROM last destination city
            upsert_edge(g, "Route", "flight_number", flight_no, "TO", "City", "name", dest_cities[-1])

    # ── 9. Theme 노드 + TAGGED 엣지 ──
    themes = classify_themes(
        data.get("hashtags") or [],
        data.get("highlights") or [],
        data.get("product_tags") or [],
    )
    for theme in themes:
        upsert_vertex(g, "Theme", "name", theme, {})
        stats["Theme"] += 1
        upsert_edge(g, "Package", "code", code, "TAGGED", "Theme", "name", theme,
                     {"layer": 5, "weight": 0.10})

    # ── 10. Season 노드 + POPULAR_IN 엣지 ──
    # 출발 날짜 기반 시즌 (우선) + 해시태그/패키지명 키워드 (보조)
    seasons = set(detect_season(data))
    text = f"{data.get('package_name', '')} {' '.join(data.get('hashtags') or [])}"
    for season, keywords in [("봄", ["봄", "벚꽃", "spring"]), ("여름", ["여름", "summer"]),
                              ("가을", ["가을", "단풍", "autumn"]), ("겨울", ["겨울", "winter", "스키"])]:
        if any(kw in text for kw in keywords):
            seasons.add(season)
    for season in seasons:
        upsert_vertex(g, "Season", "name", season, {})
        upsert_edge(g, "Package", "code", code, "POPULAR_IN", "Season", "name", season)


def compute_similar_packages(g: GraphTraversalSource, stats: Counter) -> None:
    """패키지 간 유사도 계산 (자카드 유사도: 공유 City 기반) -> SIMILAR_TO 엣지."""
    print("\n패키지 간 유사도 계산 중...")

    # 모든 패키지와 방문 도시 수집
    packages = g.V().hasLabel("Package").project("code", "cities").by("code").by(
        __.out("VISITS").hasLabel("City").values("name").fold()
    ).toList()

    created = 0
    for i, p1 in enumerate(packages):
        cities1 = set(p1["cities"])
        if not cities1:
            continue
        for p2 in packages[i + 1:]:
            cities2 = set(p2["cities"])
            if not cities2:
                continue
            intersection = cities1 & cities2
            union = cities1 | cities2
            if not union:
                continue
            jaccard = len(intersection) / len(union)
            if jaccard >= 0.3:  # 30% 이상 겹침
                upsert_edge(g, "Package", "code", p1["code"],
                            "SIMILAR_TO", "Package", "code", p2["code"],
                            {"score": round(jaccard, 2)})
                created += 1

    stats["SIMILAR_TO"] = created
    print(f"  SIMILAR_TO 엣지: {created}개 생성")


def compute_near_cities(g: GraphTraversalSource, stats: Counter) -> None:
    """같은 Region에 속한 City 간 NEAR 엣지 생성."""
    print("\n인접 도시 관계 계산 중...")

    regions = g.V().hasLabel("Region").values("name").toList()
    created = 0
    for region_name in regions:
        cities = g.V().hasLabel("City").has("region", region_name).values("name").toList()
        for i, c1 in enumerate(cities):
            for c2 in cities[i + 1:]:
                upsert_edge(g, "City", "name", c1, "NEAR", "City", "name", c2, {"same_region": True})
                created += 1

    stats["NEAR"] = created
    print(f"  NEAR 엣지: {created}개 생성")


# ============================================================
# 메인
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="크롤링 JSON -> Gremlin Graph DB 적재")
    parser.add_argument("--data-dir", default="./data", help="크롤링 JSON 디렉토리")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="Gremlin 엔드포인트")
    parser.add_argument("--drop-all", action="store_true", help="기존 그래프 전체 삭제 후 적재 (Trend/TrendSpot 보존)")
    parser.add_argument("--dry-run", action="store_true", help="접속 없이 통계만 출력")
    args = parser.parse_args()

    # JSON 파일 수집
    pattern = os.path.join(args.data_dir, "hanatour_*.json")
    files = [f for f in sorted(glob.glob(pattern)) if "all" not in f]
    print(f"적재 대상: {len(files)}개 파일 ({args.data_dir})")

    if not files:
        print("파일 없음. --data-dir 경로를 확인하세요.")
        sys.exit(1)

    if args.dry_run:
        print("\n[Dry-run] 접속 없이 통계만 출력합니다.")
        stats: Counter = Counter()
        for f in files:
            with open(f, encoding="utf-8") as fh:
                data = json.load(fh)
            stats["Package"] += 1
            stats["City"] += len(data.get("city_list") or [])
            stats["Attraction"] += len(data.get("attractions") or [])
            # Count itinerary attractions too
            for day_info in (data.get("itinerary") or []):
                stats["Attraction"] += len(day_info.get("attractions") or [])
            stats["Hotel"] += len(data.get("hotels") or [])
            stats["Route"] += sum(1 for k in ["departure_flight", "return_flight"]
                                  if data.get(k, {}).get("flight_number"))
            stats["Theme"] += len(classify_themes(
                data.get("hashtags") or [], data.get("highlights") or [], data.get("product_tags") or []))
        print("\n예상 노드 수 (중복 포함):")
        for label, count in stats.most_common():
            print(f"  {label}: {count}")
        return

    # Gremlin 접속
    print(f"\nGremlin 접속: {args.endpoint}")
    conn = create_neptune_connection(args.endpoint)
    g = traversal().withRemote(conn)

    try:
        if args.drop_all:
            print("기존 패키지 그래프 삭제 중 (Trend/TrendSpot 보존)...")
            for label in ["Package", "Country", "Region", "City", "Attraction",
                          "Hotel", "Airline", "Route", "Theme", "Season"]:
                g.V().hasLabel(label).drop().iterate()
            print("  삭제 완료")

        stats = Counter()
        start = time.time()

        for i, filepath in enumerate(files, 1):
            with open(filepath, encoding="utf-8") as fh:
                data = json.load(fh)

            code = data.get("product_code") or os.path.basename(filepath)
            name = (data.get("package_name") or "")[:40]
            print(f"\n[{i}/{len(files)}] {code} -- {name}")

            load_package(g, data, stats)

        # 관계 보강
        compute_similar_packages(g, stats)
        compute_near_cities(g, stats)

        elapsed = time.time() - start

        # 최종 통계
        total_v = g.V().count().next()
        total_e = g.E().count().next()

        print(f"\n{'='*60}")
        print(f"적재 완료 ({elapsed:.1f}초)")
        print(f"{'='*60}")
        print(f"\n총 노드: {total_v}개")
        print(f"총 엣지: {total_e}개")
        print(f"\n노드별 적재 수 (중복 포함 호출 수):")
        for label, count in stats.most_common():
            print(f"  {label}: {count}")

        # 라벨별 실제 노드 수
        print(f"\n라벨별 실제 노드 수:")
        for label in ["Package", "Country", "Region", "City", "Attraction",
                       "Hotel", "Airline", "Route", "Theme", "Season"]:
            count = g.V().hasLabel(label).count().next()
            if count > 0:
                print(f"  {label}: {count}")

        # Trend/TrendSpot도 표시 (별도 관리 데이터)
        for label in ["Trend", "TrendSpot"]:
            count = g.V().hasLabel(label).count().next()
            if count > 0:
                print(f"  {label}: {count} (trend-collector 관리)")

        print(f"\n엣지별 실제 수:")
        for edge_label in ["VISITS", "INCLUDES", "INCLUDES_HOTEL", "DEPARTS_ON",
                           "TAGGED", "USES", "IN_COUNTRY", "IN_REGION", "BELONGS_TO",
                           "HAS_ATTRACTION", "HAS_HOTEL", "NEAR", "SIMILAR_TO",
                           "POPULAR_IN", "OPERATES", "TO"]:
            count = g.E().hasLabel(edge_label).count().next()
            if count > 0:
                print(f"  {edge_label}: {count}")

    finally:
        conn.close()
        print("\nGremlin 연결 종료.")


if __name__ == "__main__":
    main()
