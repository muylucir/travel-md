"""5-Layer Similarity Dial: determines which layers to retain vs. modify.

Layer structure
---------------
Layer 1 -- route (cities/flights) : weight 0.95 -- the skeleton
Layer 2 -- hotel                  : weight 0.70 -- accommodation
Layer 3 -- attraction             : weight 0.50 -- highlights
Layer 4 -- activity               : weight 0.30 -- easy to swap; trend insertion target
Layer 5 -- theme                  : weight 0.10 -- always changeable
"""

from typing import Dict

LAYER_WEIGHTS: Dict[str, float] = {
    "route": 0.95,
    "hotel": 0.70,
    "attraction": 0.50,
    "activity": 0.30,
    "theme": 0.10,
}

LAYER_DESCRIPTIONS: Dict[str, str] = {
    "route": "노선/도시 (여행의 뼈대)",
    "hotel": "숙박 (호텔/료칸)",
    "attraction": "핵심 관광지 (여행 하이라이트)",
    "activity": "세부 액티비티 (트렌드 삽입 대상)",
    "theme": "분위기/테마 (항상 변경 가능)",
}

LAYER_TOOL_MAP: Dict[str, list] = {
    "route": ["get_routes_by_region", "get_nearby_cities"],
    "hotel": ["get_hotels_by_city"],
    "attraction": ["get_attractions_by_city"],
    "activity": ["get_attractions_by_city"],
    "theme": ["search_packages", "get_attractions_by_city"],
}


def compute_change_rules(similarity: int) -> Dict[str, str]:
    """Determine retain/modify decision for each layer given a similarity level.

    Parameters
    ----------
    similarity:
        0-100 integer. 100 means nearly identical to reference; 0 means
        completely new.

    Returns
    -------
    dict mapping layer name to either ``"retain"`` or ``"modify"``.
    """
    threshold = 1.0 - (similarity / 100)
    return {
        layer: "retain" if weight > threshold else "modify"
        for layer, weight in LAYER_WEIGHTS.items()
    }


def format_rules_for_prompt(
    similarity: int,
    reference_data: dict | None = None,
) -> str:
    """Format the 5-Layer change rules into a human-readable string for LLM prompt injection.

    Parameters
    ----------
    similarity:
        0-100 integer.
    reference_data:
        Optional dict with concrete reference values for retain layers.
        Expected keys (all optional):
          - cities: list[str]                 (L1)
          - departure_flight, return_flight: str  (L1)
          - hotels: list[str]                 (L2)
          - attractions: list[str]            (L3)
          - activities: list[str]             (L4)
          - themes: list[str]                 (L5)
        For each retain layer, the prompt is augmented with a
        "**MUST USE EXACTLY**" directive listing those values.

    Returns
    -------
    A multi-line string suitable for embedding in a system or user prompt.
    """
    rules = compute_change_rules(similarity)
    threshold = 1.0 - (similarity / 100)

    lines = [
        f"## 유사도 규칙 (similarity={similarity}%, threshold={threshold:.2f})",
        "",
        "이 규칙은 **시스템 강제 사항**입니다. 위반 시 후처리 검증에서 차단됩니다.",
        "",
    ]

    for layer, decision in rules.items():
        weight = LAYER_WEIGHTS[layer]
        desc = LAYER_DESCRIPTIONS[layer]
        icon = "RETAIN" if decision == "retain" else "MODIFY"
        tool_hint = ""
        if decision == "modify" and layer in LAYER_TOOL_MAP:
            tools = ", ".join(LAYER_TOOL_MAP[layer])
            tool_hint = f" → 활용 도구: {tools}"
        lines.append(f"- Layer [{layer}] (weight={weight:.2f}) {desc}: **{icon}**{tool_hint}")

    lines.append("")

    retained = [l for l, d in rules.items() if d == "retain"]
    modified = [l for l, d in rules.items() if d == "modify"]

    if retained:
        lines.append(f"유지 대상: {', '.join(retained)}")
    if modified:
        lines.append(f"변경 대상: {', '.join(modified)}")

    lines.append("")

    # ─── 유지 레이어의 구체적 값을 reference 에서 주입 ─────────────────────
    if reference_data and retained:
        lines.append("## 유지 레이어 — 아래 값을 **그대로 (변경 없이) 사용**하세요")
        lines.append("")
        layer_to_keys = {
            "route": [
                ("cities", "방문 도시 (city_list 에 그대로 사용)"),
                ("departure_flight", "출발 항공편"),
                ("return_flight", "귀국 항공편"),
            ],
            "hotel": [("hotels", "호텔 (hotels 배열에 그대로 사용)")],
            "attraction": [
                ("attractions", "핵심 관광지 (itinerary 의 attractions 에 모두 포함)")
            ],
            "activity": [("activities", "세부 액티비티")],
            "theme": [("themes", "테마/분위기 키워드")],
        }
        for layer in retained:
            for key, label in layer_to_keys.get(layer, []):
                value = reference_data.get(key)
                if value is None or (isinstance(value, list) and len(value) == 0):
                    continue
                if isinstance(value, list):
                    lines.append(
                        f"- **{label}** (Layer {layer}): "
                        + ", ".join(f"`{v}`" for v in value)
                    )
                else:
                    lines.append(f"- **{label}** (Layer {layer}): `{value}`")
        lines.append("")
        lines.append(
            "위 값을 누락하거나 다른 값으로 대체하면 검증에 실패하여 재생성 비용이 발생합니다."
        )
        lines.append("")

    lines.append("변경 대상 레이어는 기존 상품과 다르게 재구성하세요.")
    lines.append("유지 대상 레이어는 기존 상품의 요소를 **이름까지 정확히 그대로** 사용하세요.")

    return "\n".join(lines)


def extract_reference_data(reference_raw: object) -> dict:
    """Pick out fields from a reference SaleProduct payload to inject as
    retain-layer values.

    Accepts:
      - JSON string (MCP tool output)
      - dict matching get_package output shape
    Returns a dict with keys: cities, hotels, attractions
    (departure_flight/return_flight/themes/activities reserved for future).
    """
    import json as _json

    data: dict
    if isinstance(reference_raw, str):
        try:
            data = _json.loads(reference_raw)
        except (ValueError, TypeError):
            return {}
    elif isinstance(reference_raw, dict):
        data = reference_raw
    else:
        return {}

    # Some MCP responses wrap the payload in {"content":[{"text": "..."}]}.
    if "content" in data and isinstance(data.get("content"), list):
        try:
            inner = data["content"][0]["text"]
            data = _json.loads(inner) if isinstance(inner, str) else inner
        except (ValueError, KeyError, IndexError, TypeError):
            return {}

    if not isinstance(data, dict):
        return {}

    out: dict = {}

    # Cities: arrival + visit cities (v3) or city_list (legacy)
    cities: list[str] = []
    arr = data.get("arrivalCity")
    if isinstance(arr, dict) and arr.get("name"):
        cities.append(str(arr["name"]))
    for c in data.get("visitCities", []) or []:
        if isinstance(c, dict) and c.get("name") and c["name"] not in cities:
            cities.append(str(c["name"]))
    if not cities:
        for c in data.get("cities", []) or []:
            if isinstance(c, dict) and c.get("name") and c["name"] not in cities:
                cities.append(str(c["name"]))
    if cities:
        out["cities"] = cities

    # Hotels: hotelStays[].hotel.name (v3) or hotels[]
    hotels: list[str] = []
    seen: set[str] = set()
    for s in data.get("hotelStays", []) or []:
        if not isinstance(s, dict):
            continue
        h = s.get("hotel")
        name = (h.get("name") if isinstance(h, dict) else None) or s.get("locaDesc")
        if name and name not in seen:
            seen.add(str(name))
            hotels.append(str(name))
    if not hotels:
        for h in data.get("hotels", []) or []:
            if isinstance(h, dict) and h.get("name") and h["name"] not in seen:
                seen.add(str(h["name"]))
                hotels.append(str(h["name"]))
            elif isinstance(h, str) and h not in seen:
                seen.add(h)
                hotels.append(h)
    if hotels:
        out["hotels"] = hotels

    # Attractions: name list (v3 attractions[] or legacy)
    attrs: list[str] = []
    seen_a: set[str] = set()
    for a in data.get("attractions", []) or []:
        if isinstance(a, dict) and a.get("name") and a["name"] not in seen_a:
            seen_a.add(str(a["name"]))
            attrs.append(str(a["name"]))
    if attrs:
        out["attractions"] = attrs

    return out
