#!/usr/bin/env python3
"""Regression test for the score-first Graph RAG redesign.

Invokes the AgentCore Runtime directly with 5 representative inputs and
checks structural quality of the resulting PlanningOutput. Writes a
markdown report with verdicts.

Usage:
  python3 scripts/regression_test.py [--report=path/to/report.md]

Requires AWS credentials with bedrock-agentcore:InvokeAgentRuntime perm.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field

import boto3

REGION = os.environ.get("AWS_REGION", "ap-northeast-2")
RUNTIME_ARN = os.environ.get(
    "RUNTIME_ARN",
    "arn:aws:bedrock-agentcore:ap-northeast-2:939105814298:runtime/ota_travel_agent-fjp2B62iQc",
)
NEPTUNE_ENDPOINT = os.environ.get(
    "NEPTUNE_ENDPOINT",
    "https://db-neptune-2.cluster-cje4bejv0vps.ap-northeast-2.neptune.amazonaws.com:8182",
)


# ─── Test cases ──────────────────────────────────────────────────────────

CASES = [
    {
        "id": "C1_osaka_family_spring",
        "label": "오사카·3박·가족여행·봄·세이브",
        "input": {
            "destination": "오사카",
            "duration": {"nights": 3, "days": 4},
            "departure_season": "봄",
            "similarity_level": 50,
            "themes": ["FAMILY_WITH_KIDS", "FOODIE"],
            "brand": "세이브",
            "input_mode": "form",
        },
    },
    {
        "id": "C2_kyoto_history_summer_with_ref",
        "label": "교토·4박·역사문화·여름·참고상품·유사도70",
        "input": {
            "destination": "교토",
            "duration": {"nights": 4, "days": 5},
            "departure_season": "여름",
            "similarity_level": 70,
            "themes": ["HISTORY_CULTURE"],
            "brand": "스탠다드",
            "reference_product_id": "JOP140260329KEH",
            "input_mode": "form",
        },
    },
    {
        "id": "C3_kobe_couple_autumn",
        "label": "고베·2박·로맨틱커플·가을·자유텍스트",
        "input": {
            "destination": "고베",
            "duration": {"nights": 2, "days": 3},
            "departure_season": "가을",
            "similarity_level": 40,
            "themes": ["ROMANTIC_COUPLE", "NATURE_SCENERY"],
            "brand": "스탠다드",
            "natural_language_request": "야경 위주, 도보 이동 적게",
            "input_mode": "form",
        },
    },
    {
        "id": "C4_nara_solo_winter",
        "label": "나라·2박·혼자힐링·겨울",
        "input": {
            "destination": "나라",
            "duration": {"nights": 2, "days": 3},
            "departure_season": "겨울",
            "similarity_level": 30,
            "themes": ["SOLO_HEALING"],
            "brand": "스탠다드",
            "input_mode": "form",
        },
    },
    {
        "id": "C5_osaka_with_parents_high_similarity",
        "label": "오사카·3박·부모님동행·봄·유사도90·참고상품",
        "input": {
            "destination": "오사카",
            "duration": {"nights": 3, "days": 4},
            "departure_season": "봄",
            "similarity_level": 90,
            "themes": ["WITH_PARENTS"],
            "brand": "세이브",
            "reference_product_id": "JOP146260329BXL",
            "input_mode": "form",
        },
    },
]


# ─── Verdict types ───────────────────────────────────────────────────────

@dataclass
class Verdict:
    case_id: str
    label: str
    elapsed_s: float
    pass_count: int = 0
    fail_count: int = 0
    checks: list[tuple[str, bool, str]] = field(default_factory=list)
    output: dict | None = None
    error: str | None = None

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append((name, ok, detail))
        if ok:
            self.pass_count += 1
        else:
            self.fail_count += 1


# ─── Cypher helper for verification ──────────────────────────────────────

_neptune = None


def neptune_client():
    global _neptune
    if _neptune is None:
        _neptune = boto3.client(
            "neptunedata",
            endpoint_url=NEPTUNE_ENDPOINT,
            region_name=REGION,
        )
    return _neptune


def fetch_attraction_cities(names: list[str]) -> dict[str, set[str]]:
    """Resolve attraction name → set(city names) via Neptune."""
    if not names:
        return {}
    rows = (
        neptune_client()
        .execute_open_cypher_query(
            openCypherQuery=(
                "MATCH (a:Attraction)-[:IN_CITY]->(c:City) "
                "WHERE a.name IN $names "
                "RETURN a.name AS name, collect(DISTINCT c.name) AS cities"
            ),
            parameters=json.dumps({"names": names}),
        )
        .get("results", [])
    )
    out: dict[str, set[str]] = {}
    for r in rows:
        out[r["name"]] = {c for c in (r.get("cities") or []) if c}
    return out


# ─── Runtime invocation ──────────────────────────────────────────────────

def invoke_runtime(payload: dict) -> dict:
    """Invoke ota_travel_agent and parse SSE/JSON response.

    Workaround: control-plane endpoint check before invoke seems to wake
    the runtime endpoint and avoid sporadic ResourceNotFoundException.
    Retries on ResourceNotFoundException by recreating the client.
    """
    from botocore.config import Config

    cfg = Config(read_timeout=600, connect_timeout=10, retries={"max_attempts": 0})

    # Wake control-plane: confirm endpoint exists before data-plane call
    runtime_id = RUNTIME_ARN.split("/")[-1]
    try:
        ctrl = boto3.client("bedrock-agentcore-control", region_name=REGION)
        ctrl.list_agent_runtime_endpoints(agentRuntimeId=runtime_id)
    except Exception:  # noqa: BLE001
        pass

    last_err: Exception | None = None
    response = None
    for attempt in range(4):
        # Fresh client each attempt — boto3 may cache endpoint resolution
        client = boto3.client("bedrock-agentcore", region_name=REGION, config=cfg)
        session_id = "regtest-" + uuid.uuid4().hex
        try:
            response = client.invoke_agent_runtime(
                agentRuntimeArn=RUNTIME_ARN,
                runtimeSessionId=session_id,
                payload=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                contentType="application/json",
                accept="text/event-stream, application/json",
            )
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            if "ResourceNotFoundException" not in repr(e):
                raise
            time.sleep(3 + attempt * 4)
    if response is None:
        raise last_err or RuntimeError("invoke_agent_runtime failed")

    body = b""
    stream = response.get("response")
    if stream is not None:
        try:
            for chunk in stream:
                body += chunk
        except Exception:  # noqa: BLE001
            pass
    text = body.decode("utf-8", errors="replace") if isinstance(body, bytes) else body
    return parse_sse_or_json(text)


def parse_sse_or_json(text: str) -> dict:
    """Pull the final 'result'-like event from a stream or JSON blob."""
    text = text.strip()
    # Try plain JSON first
    try:
        data = json.loads(text)
        if isinstance(data, dict) and "payload" in data:
            inner = data["payload"]
            return json.loads(inner) if isinstance(inner, str) else inner
        if isinstance(data, dict):
            return data
    except (ValueError, TypeError):
        pass

    # SSE: collect events, prefer 'result' / 'output' / 'planning_completed'
    last_data = None
    final = None
    cur_event = None
    for line in text.splitlines():
        line = line.rstrip()
        if line.startswith("event:"):
            cur_event = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            payload_str = line.split(":", 1)[1].strip()
            try:
                payload = json.loads(payload_str)
            except (ValueError, TypeError):
                payload = payload_str
            last_data = payload
            if cur_event in ("result", "planning_completed", "output"):
                final = payload
    return final if final is not None else (last_data if last_data is not None else {})


# ─── Checks ──────────────────────────────────────────────────────────────

def check_case(verdict: Verdict, case: dict, output: dict) -> None:
    inp = case["input"]

    # 1. similarity_score 가 입력값과 동일
    requested = int(inp.get("similarity_level", 50))
    actual = output.get("similarity_score")
    verdict.add(
        "similarity_score 동기화",
        actual == requested,
        f"requested={requested}, actual={actual}",
    )

    # 2. brand 일치
    verdict.add(
        "brand 일치",
        output.get("brand") == inp.get("brand"),
        f"input={inp.get('brand')}, output={output.get('brand')}",
    )

    # 3. nights/days 일치
    nights = (inp.get("duration") or {}).get("nights")
    verdict.add(
        "nights 일치",
        output.get("nights") == nights,
        f"input={nights}, output={output.get('nights')}",
    )

    # 4. itinerary 모든 day 가 day_cities 의 명소만 포함
    itinerary = output.get("itinerary") or []
    all_names: set[str] = set()
    day_to_names: dict[int, list[str]] = {}
    day_to_cities: dict[int, set[str]] = {}
    for d in itinerary:
        day = d.get("day")
        names = list(d.get("attractions") or [])
        all_names.update(names)
        day_to_names[day] = names
        day_to_cities[day] = {
            c.strip() for c in (d.get("cities") or "").split(",") if c.strip()
        }

    if all_names:
        attr_cities = fetch_attraction_cities(list(all_names))
        violations = []
        not_in_graph = []
        for day_num, names in day_to_names.items():
            day_cities = day_to_cities.get(day_num) or set()
            for name in names:
                cities = attr_cities.get(name)
                if cities is None:
                    not_in_graph.append((day_num, name))
                elif day_cities and not (cities & day_cities):
                    violations.append((day_num, name, cities, day_cities))
        verdict.add(
            "Day 도시 scope 정합 (Cypher 검증)",
            len(violations) == 0,
            (
                f"violations={len(violations)} (예: "
                + (
                    f"Day {violations[0][0]} '{violations[0][1]}' actual={violations[0][2]} day_cities={violations[0][3]}"
                    if violations
                    else "없음"
                )
                + ")"
            )
            if violations
            else "0 위반",
        )
        verdict.add(
            "그래프 명소 그라운딩 (환각 없음)",
            len(not_in_graph) == 0,
            f"환각={len(not_in_graph)}건"
            + (f" (예: Day {not_in_graph[0][0]} '{not_in_graph[0][1]}')" if not_in_graph else ""),
        )

    # 5. graph_trace 가 있고 recommend_attractions 호출이 있는지
    trace = output.get("graph_trace") or []
    used_tools = [c.get("tool") for c in trace if isinstance(c, dict)]
    rec_calls = sum(1 for t in used_tools if t == "recommend_attractions")
    verdict.add(
        "recommend_attractions 호출 ≥ 1",
        rec_calls >= 1,
        f"호출 {rec_calls}회 (총 {len(trace)} calls). tools={used_tools[:5]}",
    )

    # 6. selected_ids 다중 호출 패턴 — 같은 도시에 여러 번 호출되었는지
    rec_arg_log = [
        c.get("arguments") or {}
        for c in trace
        if isinstance(c, dict) and c.get("tool") == "recommend_attractions"
    ]
    by_city: dict[str, int] = {}
    has_selected = False
    for a in rec_arg_log:
        c = a.get("city")
        if c:
            by_city[c] = by_city.get(c, 0) + 1
        if a.get("selected_ids"):
            has_selected = True
    multi_city_count = sum(1 for v in by_city.values() if v >= 2)
    verdict.add(
        "selected_ids 다중 호출 패턴",
        has_selected or multi_city_count > 0,
        f"selected_ids 사용={has_selected}, 도시별 다회 호출={multi_city_count}",
    )

    # 7. similarity 70 이상이면 reference 도시·호텔 set retain
    ref_id = inp.get("reference_product_id")
    if ref_id and requested >= 70:
        # check city_list ⊇ reference cities
        reference_pkg_calls = [
            c for c in trace if isinstance(c, dict) and c.get("tool") in ("get_reference_package", "plan_context_bundle")
        ]
        verdict.add(
            "similarity≥70 시 plan_context_bundle/get_reference_package 호출",
            len(reference_pkg_calls) >= 1,
            f"호출 {len(reference_pkg_calls)}회",
        )

    # 8. itinerary day 수 = days
    days = (inp.get("duration") or {}).get("days")
    verdict.add(
        "itinerary day 수 = days",
        len(itinerary) == days,
        f"days={days}, itinerary={len(itinerary)}",
    )


# ─── Runner ──────────────────────────────────────────────────────────────

def run_one(case: dict) -> Verdict:
    v = Verdict(case_id=case["id"], label=case["label"], elapsed_s=0.0)
    started = time.time()
    try:
        out = invoke_runtime(case["input"])
        v.elapsed_s = time.time() - started
        v.output = out
        if isinstance(out, dict) and out.get("error"):
            v.error = str(out.get("error"))
            v.add("Runtime 응답 오류 없음", False, str(out.get("error")))
        else:
            check_case(v, case, out if isinstance(out, dict) else {})
    except Exception as e:  # noqa: BLE001
        v.elapsed_s = time.time() - started
        v.error = repr(e)
        v.add("Runtime invoke 성공", False, repr(e))
    return v


def render_report(verdicts: list[Verdict]) -> str:
    total_pass = sum(v.pass_count for v in verdicts)
    total_fail = sum(v.fail_count for v in verdicts)
    total_checks = total_pass + total_fail

    lines = [
        "# Graph RAG Redesign — Regression Report",
        "",
        f"- 케이스: {len(verdicts)} / 검사 항목: {total_checks}",
        f"- ✅ 통과: {total_pass} ({total_pass / max(1, total_checks):.1%})",
        f"- ❌ 실패: {total_fail}",
        "",
        f"- Runtime: `{RUNTIME_ARN.split('/')[-1]}`",
        f"- 평균 latency: {sum(v.elapsed_s for v in verdicts) / max(1, len(verdicts)):.1f}s",
        "",
    ]

    for v in verdicts:
        lines.append(f"## {v.case_id} — {v.label}")
        lines.append("")
        lines.append(
            f"- Latency: **{v.elapsed_s:.1f}s** · 통과 {v.pass_count} / 실패 {v.fail_count}"
        )
        if v.error:
            lines.append(f"- Error: `{v.error}`")
        lines.append("")
        lines.append("| 검사 | 결과 | 상세 |")
        lines.append("|---|:-:|---|")
        for name, ok, detail in v.checks:
            lines.append(f"| {name} | {'✅' if ok else '❌'} | {detail} |")
        lines.append("")
        if v.output:
            o = v.output
            lines.append(f"- package_name: {o.get('package_name', '-')}")
            lines.append(f"- city_list: {o.get('city_list', '-')}")
            lines.append(f"- hotels: {o.get('hotels', '-')}")
            lines.append("- itinerary:")
            for d in (o.get("itinerary") or []):
                lines.append(
                    f"  - Day {d.get('day')} ({d.get('cities')}): "
                    + ", ".join(d.get("attractions") or [])
                )
        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--report",
        default=os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "docs",
            "redesign",
            "REGRESSION_REPORT.md",
        ),
    )
    parser.add_argument("--cases", default="")
    args = parser.parse_args()

    selected = (
        [c for c in CASES if c["id"] in args.cases.split(",")]
        if args.cases
        else CASES
    )
    print(f"Running {len(selected)} cases against {RUNTIME_ARN}")

    verdicts: list[Verdict] = []
    for case in selected:
        print(f"  ▶ {case['id']} — {case['label']} ...", flush=True)
        v = run_one(case)
        verdicts.append(v)
        emoji = "✅" if v.fail_count == 0 else "❌"
        print(
            f"    {emoji} pass={v.pass_count} fail={v.fail_count} latency={v.elapsed_s:.1f}s"
        )

    report = render_report(verdicts)
    os.makedirs(os.path.dirname(args.report), exist_ok=True)
    with open(args.report, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"\nReport: {args.report}")

    # Exit code: non-zero if any fail
    if sum(v.fail_count for v in verdicts) > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
