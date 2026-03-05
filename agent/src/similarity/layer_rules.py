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


def format_rules_for_prompt(similarity: int) -> str:
    """Format the 5-Layer change rules into a human-readable string for LLM prompt injection.

    Parameters
    ----------
    similarity:
        0-100 integer.

    Returns
    -------
    A multi-line string suitable for embedding in a system or user prompt.
    """
    rules = compute_change_rules(similarity)
    threshold = 1.0 - (similarity / 100)

    lines = [
        f"## 유사도 규칙 (similarity={similarity}%, threshold={threshold:.2f})",
        "",
    ]

    for layer, decision in rules.items():
        weight = LAYER_WEIGHTS[layer]
        desc = LAYER_DESCRIPTIONS[layer]
        icon = "RETAIN" if decision == "retain" else "MODIFY"
        lines.append(f"- Layer [{layer}] (weight={weight:.2f}) {desc}: **{icon}**")

    lines.append("")

    # Summary of what to change
    retained = [l for l, d in rules.items() if d == "retain"]
    modified = [l for l, d in rules.items() if d == "modify"]

    if retained:
        lines.append(f"유지 대상: {', '.join(retained)}")
    if modified:
        lines.append(f"변경 대상: {', '.join(modified)}")

    lines.append("")
    lines.append("변경 대상 레이어는 기존 상품과 다르게 재구성하세요.")
    lines.append("유지 대상 레이어는 기존 상품의 요소를 그대로 사용하세요.")
    lines.append("트렌드 스팟은 activity/theme 레이어에 자연스럽게 삽입하세요.")

    return "\n".join(lines)
