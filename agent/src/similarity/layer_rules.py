"""5-Layer Similarity Dial — gradient (ratio-based) version.

Earlier this module returned a per-layer ``"retain"|"modify"`` decision based
on a single threshold, which produced an awkward cliff: similarity 49 vs 50
flipped a whole layer between full keep and full replace. The current version
returns a continuous **retain ratio** in ``[0, 1]`` per layer, which lets the
skeleton/day stages preserve a fraction of the reference (e.g. 7/14 attractions
when similarity=50%). The legacy ``compute_change_rules`` function is kept as
a thin compatibility shim built on top of the ratios.

Layer structure
---------------
Layer 1 -- route (cities/flights) : weight 0.95 -- the skeleton
Layer 2 -- hotel                  : weight 0.70 -- accommodation
Layer 3 -- attraction             : weight 0.50 -- highlights
Layer 4 -- activity               : weight 0.30 -- easy to swap; trend insertion target
Layer 5 -- theme                  : weight 0.10 -- always changeable
"""

from __future__ import annotations

import json as _json
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

# Per-layer offsets shape the gradient: heavier layers (route, hotel) keep
# more even at low similarity; lighter layers (theme, activity) only kick in
# at higher similarity. Tuned so similarity=50% lands at the layer's nominal
# weight (0.95, 0.70, 0.50, 0.30, 0.10).
_LAYER_OFFSETS: Dict[str, float] = {
    "route":      0.45,
    "hotel":      0.20,
    "attraction": 0.0,
    "activity":   -0.20,
    "theme":      -0.40,
}


def compute_retain_ratio(similarity: int) -> Dict[str, float]:
    """Return per-layer retain ratio in [0, 1].

    Each layer's ratio = clamp(similarity/100 + offset, 0, 1).  The offsets
    are sized so that at similarity=50 each layer matches its nominal weight,
    giving a smooth gradient instead of an on/off threshold.
    """
    s = max(0, min(100, int(similarity))) / 100.0
    return {
        layer: max(0.0, min(1.0, s + offset))
        for layer, offset in _LAYER_OFFSETS.items()
    }


def keep_count(ratio: float, total: int) -> int:
    """Round a ratio×total to a non-negative integer count."""
    if total <= 0:
        return 0
    return max(0, min(total, round(total * float(ratio))))


def compute_change_rules(similarity: int) -> Dict[str, str]:
    """Legacy boolean view of the gradient (ratio >= 0.5 → 'retain').

    Kept for back-compat with code/UI that branches on retain/modify.
    New code should use :func:`compute_retain_ratio` directly.
    """
    ratios = compute_retain_ratio(similarity)
    return {layer: ("retain" if r >= 0.5 else "modify") for layer, r in ratios.items()}


def select_preserved(reference_items: list, ratio: float) -> list:
    """Pick the first round(len*ratio) items from a reference list.

    The reference list is assumed to already be in priority order (graph
    score, schedule order, etc.), so taking the head preserves the most
    important items at any given ratio.
    """
    if not reference_items:
        return []
    n = keep_count(ratio, len(reference_items))
    return list(reference_items[:n])


def format_rules_for_prompt(
    similarity: int,
    reference_data: dict | None = None,
) -> str:
    """Render gradient retain rules + reference values for LLM prompt injection.

    Each layer shows ``kept N / total`` with the concrete preserved values,
    so the model can be told "include exactly these names; everything else
    is yours to design freely".
    """
    ratios = compute_retain_ratio(similarity)

    lines = [
        f"## 유사도 규칙 (similarity={similarity}%, 그라디언트)",
        "",
        "각 layer 별로 reference 의 일부만 보존하고 나머지는 자유롭게 재구성합니다.",
        "보존 항목 리스트는 **이름까지 정확히 그대로** 사용하세요. 누락 시 검증 실패.",
        "",
    ]

    layer_to_keys = {
        "route": ("cities", "도시 (city_list 에 그대로 포함)"),
        "hotel": ("hotels", "호텔 (hotels 배열에 그대로 포함)"),
        "attraction": ("attractions", "핵심 관광지 (itinerary 의 attractions 에 모두 등장)"),
        "activity": ("activities", "액티비티"),
        "theme": ("themes", "테마/분위기"),
    }

    for layer, ratio in ratios.items():
        weight = LAYER_WEIGHTS[layer]
        desc = LAYER_DESCRIPTIONS[layer]
        ref_key, ref_label = layer_to_keys.get(layer, ("", ""))
        ref_list = (reference_data or {}).get(ref_key) or []
        total = len(ref_list)
        keep_n = keep_count(ratio, total)

        if total == 0:
            lines.append(
                f"- Layer [{layer}] (weight={weight:.2f}) {desc}: ratio={ratio:.2f} (reference 정보 없음)"
            )
            continue

        preserved = list(ref_list[:keep_n])
        replaced_n = total - keep_n
        line = (
            f"- Layer [{layer}] (weight={weight:.2f}) {desc}: "
            f"ratio={ratio:.2f} → **보존 {keep_n}/{total}**"
        )
        if replaced_n > 0:
            line += f", 신규 {replaced_n}개 추가 가능"
        lines.append(line)
        if preserved:
            lines.append(
                f"  · {ref_label} — 보존: " + ", ".join(f"`{v}`" for v in preserved)
            )
        if replaced_n > 0 and ref_list[keep_n:]:
            sample = ref_list[keep_n:keep_n + 3]
            extra = "..." if replaced_n > 3 else ""
            lines.append(
                f"  · 변경 가능한 reference 항목: "
                + ", ".join(f"`{v}`" for v in sample)
                + extra
            )

    lines.append("")
    lines.append(
        "위에서 ‘보존’ 으로 명시된 모든 항목은 결과에 정확한 이름으로 포함되어야 합니다."
    )
    lines.append(
        "보존 외 슬롯은 사용자 자유 텍스트·테마·시즌 가중치로 자유롭게 재구성하세요."
    )

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

    # Attractions: prefer scheduledAttractions[] (v3 redesign), else attractions[]
    # Track each attraction's city so similarity preservation can place it on
    # a day whose cities actually contain it.
    attrs: list[str] = []
    attr_cities: dict[str, str] = {}
    seen_a: set[str] = set()
    for a in (data.get("scheduledAttractions") or []) or (
        data.get("attractions") or []
    ):
        if not isinstance(a, dict):
            continue
        name = a.get("name")
        if not name or name in seen_a:
            continue
        seen_a.add(str(name))
        attrs.append(str(name))
        city = a.get("cityName") or a.get("city")
        if city:
            attr_cities[str(name)] = str(city)
    if attrs:
        out["attractions"] = attrs
    if attr_cities:
        out["attraction_cities"] = attr_cities

    return out


def compute_achieved_similarity(
    output_obj, reference_data: dict
) -> dict:
    """Compute the actual layer-weighted Jaccard between output and reference.

    Returns ``{"achieved": 0..100, "breakdown": {layer: 0..100}}``.  Only the
    three layers that have concrete reference data (route/hotel/attraction)
    contribute; lighter layers (activity/theme) are summarized in the LLM's
    free-text changes_summary instead.
    """
    def jaccard(a: set, b: set) -> float:
        if not a and not b:
            return 1.0
        return len(a & b) / max(1, len(a | b))

    ref_cities = set(reference_data.get("cities") or [])
    out_cities = set(getattr(output_obj, "city_list", None) or [])
    route = jaccard(ref_cities, out_cities)

    ref_hotels = set(reference_data.get("hotels") or [])
    out_hotels = set(getattr(output_obj, "hotels", None) or [])
    hotel = jaccard(ref_hotels, out_hotels)

    ref_attrs = set(reference_data.get("attractions") or [])
    out_attrs: set[str] = set()
    for d in getattr(output_obj, "itinerary", None) or []:
        for n in getattr(d, "attractions", None) or []:
            if n:
                out_attrs.add(n)
    attr = jaccard(ref_attrs, out_attrs)

    weights = {
        "route": LAYER_WEIGHTS["route"],
        "hotel": LAYER_WEIGHTS["hotel"],
        "attraction": LAYER_WEIGHTS["attraction"],
    }
    weight_sum = sum(weights.values())
    weighted = (
        route * weights["route"]
        + hotel * weights["hotel"]
        + attr * weights["attraction"]
    ) / weight_sum if weight_sum else 0.0

    return {
        "achieved": int(round(weighted * 100)),
        "breakdown": {
            "route": int(round(route * 100)),
            "hotel": int(round(hotel * 100)),
            "attraction": int(round(attr * 100)),
        },
    }
