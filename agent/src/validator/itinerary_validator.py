"""Programmatic itinerary validation.

Checks feasibility of a generated itinerary without calling an LLM.
Runs in ~1-2 seconds.

Scoring: 100 - (ERROR x 15) - (WARNING x 5)
Pass threshold: score >= 70
"""

from __future__ import annotations

import logging
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

from src.models.output import PlanningOutput, DayItinerary

logger = logging.getLogger(__name__)

# Constants
DAILY_START_HOUR = 9   # 09:00
DAILY_END_HOUR = 22    # 22:00
AVAILABLE_HOURS = DAILY_END_HOUR - DAILY_START_HOUR  # 13 hours
FLIGHT_BUFFER_HOURS = 3  # 3-hour buffer around flights
AVG_ATTRACTION_HOURS = 1.5  # Average time per attraction
AVG_TRANSIT_MINUTES = 30  # Average transit between attractions
HOTEL_ACCESS_DEADLINE_HOUR = 22  # Must reach hotel by 22:00
MAX_TRANSIT_MINUTES = 60  # Max acceptable transit time in urban areas


class Severity(str, Enum):
    ERROR = "ERROR"
    WARNING = "WARNING"


class Issue(BaseModel):
    """A single validation issue."""

    severity: Severity
    day: Optional[int] = None
    message: str
    suggestion: str = ""


class ValidationResult(BaseModel):
    """Result of itinerary validation."""

    score: int = Field(..., ge=0, le=100)
    passed: bool
    issues: list[Issue] = Field(default_factory=list)
    correction_guide: str = Field(
        default="",
        description="Formatted guide for the LLM to fix issues on retry.",
    )


def validate_itinerary(output: PlanningOutput) -> ValidationResult:
    """Run all programmatic validation checks on a PlanningOutput."""
    issues: list[Issue] = []

    # Per-day checks
    for day_plan in output.itinerary:
        issues.extend(_validate_time_budget(day_plan))
        issues.extend(_validate_hotel_access(day_plan))

    # Flight checks
    issues.extend(_validate_flight_times(output))

    # Distance / transit checks
    for day_plan in output.itinerary:
        issues.extend(_validate_distances(day_plan))

    # Basic structure checks
    issues.extend(_validate_structure(output))

    # Cross-day checks
    issues.extend(_validate_city_transitions(output))
    issues.extend(_validate_hotel_next_day_proximity(output))
    issues.extend(_validate_itinerary_continuity(output))

    # Score calculation
    error_count = sum(1 for i in issues if i.severity == Severity.ERROR)
    warning_count = sum(1 for i in issues if i.severity == Severity.WARNING)
    score = max(0, 100 - (error_count * 15) - (warning_count * 5))
    passed = score >= 70

    # Build correction guide
    correction_guide = ""
    if not passed:
        correction_guide = _build_correction_guide(issues)

    return ValidationResult(
        score=score,
        passed=passed,
        issues=issues,
        correction_guide=correction_guide,
    )


def _validate_time_budget(day: DayItinerary) -> list[Issue]:
    """Check that daily activities fit within the 09:00-22:00 window (13 hours)."""
    issues: list[Issue] = []

    attraction_count = len(day.attractions)

    # Estimated total hours
    attraction_hours = attraction_count * AVG_ATTRACTION_HOURS
    transit_hours = max(0, (attraction_count - 1)) * (AVG_TRANSIT_MINUTES / 60)
    total_hours = attraction_hours + transit_hours

    if total_hours > AVAILABLE_HOURS:
        issues.append(Issue(
            severity=Severity.ERROR,
            day=day.day,
            message=(
                f"{day.day}일차: 예상 소요시간 {total_hours:.1f}시간이 "
                f"가용시간 {AVAILABLE_HOURS}시간을 초과합니다 "
                f"(관광지 {attraction_count}곳)."
            ),
            suggestion=(
                f"{day.day}일차의 관광지 수를 줄이세요. "
                f"현재 {attraction_count}개를 "
                f"{max(1, int(AVAILABLE_HOURS / (AVG_ATTRACTION_HOURS + AVG_TRANSIT_MINUTES / 60)))}개 이하로 줄이는 것을 권장합니다."
            ),
        ))
    elif total_hours > AVAILABLE_HOURS * 0.9:
        issues.append(Issue(
            severity=Severity.WARNING,
            day=day.day,
            message=(
                f"{day.day}일차: 예상 소요시간 {total_hours:.1f}시간이 "
                f"가용시간의 90%를 초과합니다. 일정이 빡빡할 수 있습니다."
            ),
            suggestion=f"{day.day}일차의 일정을 1-2개 줄이거나 인근 관광지로 대체하세요.",
        ))

    return issues


def _validate_hotel_access(day: DayItinerary) -> list[Issue]:
    """Check that the traveler can reach their hotel by 22:00."""
    issues: list[Issue] = []

    # Parse cities from comma-separated string
    city_list = [c.strip() for c in day.cities.split(",") if c.strip()] if day.cities else []
    if len(city_list) > 3:
        issues.append(Issue(
            severity=Severity.WARNING,
            day=day.day,
            message=(
                f"{day.day}일차: {len(city_list)}개 도시를 방문하며 숙소 접근이 "
                f"22:00 이후로 늦어질 수 있습니다."
            ),
            suggestion=f"{day.day}일차의 방문 도시 수를 2-3개로 줄이세요.",
        ))

    return issues


def _validate_flight_times(output: PlanningOutput) -> list[Issue]:
    """Check 3-hour buffer around flight times on first and last day."""
    issues: list[Issue] = []
    itinerary = output.itinerary

    if not itinerary:
        return issues

    # First day: arrival + 3h buffer before first activity
    try:
        arr_time = output.departure_flight.arrival_time
        arr_hour, _ = map(int, arr_time.split(":"))
        earliest_activity_hour = arr_hour + FLIGHT_BUFFER_HOURS
        first_day = itinerary[0]

        if earliest_activity_hour > DAILY_END_HOUR and len(first_day.attractions) > 1:
            issues.append(Issue(
                severity=Severity.ERROR,
                day=1,
                message=(
                    f"1일차: 항공편 도착 {arr_time} + 3시간 버퍼 후 "
                    f"{earliest_activity_hour}:00부터 가능하나, 관광지가 과다합니다."
                ),
                suggestion="1일차에는 도착 후 이동 + 1-2개 가벼운 일정만 배치하세요.",
            ))
        elif earliest_activity_hour >= 18 and len(first_day.attractions) > 2:
            issues.append(Issue(
                severity=Severity.WARNING,
                day=1,
                message=(
                    f"1일차: 늦은 도착({arr_time})으로 관광 시간이 부족할 수 있습니다."
                ),
                suggestion="1일차 관광지를 2개 이하로 줄이세요.",
            ))
    except (ValueError, AttributeError):
        issues.append(Issue(
            severity=Severity.WARNING,
            day=1,
            message="출발편 도착 시간을 파싱할 수 없습니다.",
        ))

    # Last day: must arrive at airport 3h before departure
    try:
        dep_time = output.return_flight.departure_time
        dep_hour, _ = map(int, dep_time.split(":"))
        last_activity_deadline_hour = dep_hour - FLIGHT_BUFFER_HOURS
        last_day = itinerary[-1]

        if last_activity_deadline_hour < DAILY_START_HOUR + 2 and len(last_day.attractions) > 1:
            issues.append(Issue(
                severity=Severity.ERROR,
                day=last_day.day,
                message=(
                    f"{last_day.day}일차(마지막): 귀국편 출발 {dep_time} "
                    f"기준 3시간 전 공항 도착 필요. 관광 시간이 거의 없습니다."
                ),
                suggestion=f"{last_day.day}일차에는 공항 이동만 배치하거나 관광지를 1개 이하로 줄이세요.",
            ))
        elif last_activity_deadline_hour < 14 and len(last_day.attractions) > 2:
            issues.append(Issue(
                severity=Severity.WARNING,
                day=last_day.day,
                message=(
                    f"{last_day.day}일차(마지막): 오후 이른 시간까지만 관광 가능합니다."
                ),
                suggestion=f"{last_day.day}일차 관광지를 2개 이하로 줄이세요.",
            ))
    except (ValueError, AttributeError):
        issues.append(Issue(
            severity=Severity.WARNING,
            day=itinerary[-1].day if itinerary else None,
            message="귀국편 출발 시간을 파싱할 수 없습니다.",
        ))

    return issues


def _validate_distances(day: DayItinerary) -> list[Issue]:
    """Estimate travel times between attractions based on city count."""
    issues: list[Issue] = []

    city_list = [c.strip() for c in day.cities.split(",") if c.strip()] if day.cities else []
    distinct_cities = len(set(city_list)) if city_list else 1
    estimated_transit_per_city = 45  # minutes average between cities
    total_transit_min = max(0, distinct_cities - 1) * estimated_transit_per_city

    if total_transit_min > 180:  # More than 3 hours transit
        issues.append(Issue(
            severity=Severity.ERROR,
            day=day.day,
            message=(
                f"{day.day}일차: {distinct_cities}개 도시 간 이동시간 약 "
                f"{total_transit_min}분이 예상됩니다. 관광 시간이 크게 줄어듭니다."
            ),
            suggestion=f"{day.day}일차의 방문 도시를 인접 도시 2-3개로 줄이세요.",
        ))
    elif total_transit_min > MAX_TRANSIT_MINUTES * 2:
        issues.append(Issue(
            severity=Severity.WARNING,
            day=day.day,
            message=(
                f"{day.day}일차: 도시 간 이동시간이 {total_transit_min}분으로 "
                f"다소 길 수 있습니다."
            ),
            suggestion=f"{day.day}일차에 인접 도시 위주로 재배치를 고려하세요.",
        ))

    return issues


def _validate_structure(output: PlanningOutput) -> list[Issue]:
    """Basic structural validation checks."""
    issues: list[Issue] = []

    # Check day count matches duration
    if len(output.itinerary) != output.days:
        issues.append(Issue(
            severity=Severity.ERROR,
            message=(
                f"일정 일수({len(output.itinerary)}일)가 "
                f"여행 기간({output.days}일)과 일치하지 않습니다."
            ),
            suggestion=f"정확히 {output.days}일의 일정을 생성하세요.",
        ))

    # Check that at least one attraction exists per day (except first/last)
    for day_plan in output.itinerary:
        if not day_plan.attractions and day_plan.day not in (1, output.days):
            issues.append(Issue(
                severity=Severity.WARNING,
                day=day_plan.day,
                message=f"{day_plan.day}일차에 관광지가 없습니다.",
                suggestion=f"{day_plan.day}일차에 최소 1개의 관광지를 추가하세요.",
            ))

    # Check package_name exists
    if not output.package_name.strip():
        issues.append(Issue(
            severity=Severity.WARNING,
            message="상품명이 비어 있습니다.",
            suggestion="시즌/목적지/테마를 포함한 상품명을 생성하세요.",
        ))

    return issues


def _validate_city_transitions(output: PlanningOutput) -> list[Issue]:
    """Check consecutive days for unreasonable city jumps."""
    issues: list[Issue] = []

    DISTANT_CITY_PAIRS = {
        # Japan
        frozenset({"도쿄", "오사카"}),
        frozenset({"도쿄", "후쿠오카"}),
        frozenset({"삿포로", "오사카"}),
        frozenset({"삿포로", "도쿄"}),
        # SE Asia
        frozenset({"방콕", "치앙마이"}),
        frozenset({"하노이", "호치민"}),
        # Europe
        frozenset({"파리", "로마"}),
        frozenset({"런던", "바르셀로나"}),
    }

    itinerary = output.itinerary
    for i in range(len(itinerary) - 1):
        day_a = itinerary[i]
        day_b = itinerary[i + 1]

        cities_a = {c.strip() for c in day_a.cities.split(",") if c.strip()} if day_a.cities else set()
        cities_b = {c.strip() for c in day_b.cities.split(",") if c.strip()} if day_b.cities else set()

        # Check for known distant city pairs
        for ca in cities_a:
            for cb in cities_b:
                if frozenset({ca, cb}) in DISTANT_CITY_PAIRS:
                    issues.append(Issue(
                        severity=Severity.WARNING,
                        day=day_a.day,
                        message=(
                            f"{day_a.day}일차→{day_b.day}일차: "
                            f"{ca}에서 {cb}(으)로의 장거리 이동이 감지되었습니다. "
                            f"이동에 상당한 시간이 소요될 수 있습니다."
                        ),
                        suggestion=(
                            f"{day_a.day}일차와 {day_b.day}일차 사이에 "
                            f"이동일을 배치하거나 인접 도시로 일정을 재구성하세요."
                        ),
                    ))

        # Check for too many new cities
        new_cities = cities_b - cities_a
        if len(new_cities) > 2:
            issues.append(Issue(
                severity=Severity.WARNING,
                day=day_b.day,
                message=(
                    f"{day_b.day}일차: 전날 대비 {len(new_cities)}개의 "
                    f"새로운 도시({', '.join(sorted(new_cities))})가 등장합니다. "
                    f"이동 부담이 클 수 있습니다."
                ),
                suggestion=(
                    f"{day_b.day}일차의 새로운 도시를 2개 이하로 줄이고 "
                    f"나머지는 다른 날로 분산하세요."
                ),
            ))

    return issues


def _validate_hotel_next_day_proximity(output: PlanningOutput) -> list[Issue]:
    """Check if the last city of day i differs from the first city of day i+1."""
    issues: list[Issue] = []

    itinerary = output.itinerary
    for i in range(len(itinerary) - 1):
        day_a = itinerary[i]
        day_b = itinerary[i + 1]

        cities_a = [c.strip() for c in day_a.cities.split(",") if c.strip()] if day_a.cities else []
        cities_b = [c.strip() for c in day_b.cities.split(",") if c.strip()] if day_b.cities else []

        if not cities_a or not cities_b:
            continue

        last_city_today = cities_a[-1]
        first_city_tomorrow = cities_b[0]

        if last_city_today != first_city_tomorrow:
            issues.append(Issue(
                severity=Severity.WARNING,
                day=day_a.day,
                message=(
                    f"{day_a.day}일차 마지막 도시({last_city_today})와 "
                    f"{day_b.day}일차 첫 도시({first_city_tomorrow})가 다릅니다. "
                    f"숙소 위치 또는 아침 이동 시간을 고려해야 합니다."
                ),
                suggestion=(
                    f"{day_a.day}일차 숙소를 {first_city_tomorrow} 근처에 배치하거나, "
                    f"{day_b.day}일차 오전에 이동 시간을 확보하세요."
                ),
            ))

    return issues


def _validate_itinerary_continuity(output: PlanningOutput) -> list[Issue]:
    """Check duplicate attractions, missing attraction definitions, and unbalanced days."""
    issues: list[Issue] = []

    # Collect all attraction names across days
    all_day_attractions: list[tuple[int, str]] = []
    attractions_by_day: dict[int, list[str]] = {}
    seen_attractions: dict[str, int] = {}  # name -> first day seen

    for day_plan in output.itinerary:
        attractions_by_day[day_plan.day] = day_plan.attractions
        for attr_name in day_plan.attractions:
            all_day_attractions.append((day_plan.day, attr_name))

            # Check for duplicates across days
            if attr_name in seen_attractions:
                issues.append(Issue(
                    severity=Severity.ERROR,
                    day=day_plan.day,
                    message=(
                        f"'{attr_name}'이(가) {seen_attractions[attr_name]}일차와 "
                        f"{day_plan.day}일차에 중복 배치되었습니다."
                    ),
                    suggestion=(
                        f"'{attr_name}'을(를) 한 날에만 배치하고 "
                        f"다른 날에는 대체 관광지를 추가하세요."
                    ),
                ))
            else:
                seen_attractions[attr_name] = day_plan.day

    # Check that all itinerary attractions exist in output.attractions list
    defined_attraction_names = {a.name for a in output.attractions}
    for day_num, attr_name in all_day_attractions:
        if attr_name not in defined_attraction_names:
            issues.append(Issue(
                severity=Severity.WARNING,
                day=day_num,
                message=(
                    f"'{attr_name}'이(가) 일정에 포함되어 있지만 "
                    f"관광지 목록(attractions)에 정의되지 않았습니다."
                ),
                suggestion=f"'{attr_name}'의 설명을 attractions 목록에 추가하세요.",
            ))

    # Check for unbalanced days
    sorted_days = sorted(attractions_by_day.keys())
    for idx in range(1, len(sorted_days) - 1):
        prev_day = sorted_days[idx - 1]
        curr_day = sorted_days[idx]
        next_day = sorted_days[idx + 1]

        prev_count = len(attractions_by_day[prev_day])
        curr_count = len(attractions_by_day[curr_day])
        next_count = len(attractions_by_day[next_day])

        if prev_count >= 4 and next_count >= 4 and curr_count <= 1:
            issues.append(Issue(
                severity=Severity.WARNING,
                day=curr_day,
                message=(
                    f"{curr_day}일차의 관광지가 {curr_count}개로, "
                    f"전날({prev_count}개)·다음날({next_count}개) 대비 "
                    f"지나치게 적습니다. 일정 균형이 맞지 않습니다."
                ),
                suggestion=(
                    f"인접 일차의 관광지를 {curr_day}일차로 "
                    f"일부 이동하여 균형을 맞추세요."
                ),
            ))

    return issues


def _build_correction_guide(issues: list[Issue]) -> str:
    """Build a correction guide string for the LLM retry prompt."""
    lines = ["## 일정 검증 실패 -- 다음 문제를 수정하세요:", ""]

    errors = [i for i in issues if i.severity == Severity.ERROR]
    warnings = [i for i in issues if i.severity == Severity.WARNING]

    if errors:
        lines.append("### 오류 (반드시 수정):")
        for i, err in enumerate(errors, 1):
            lines.append(f"  {i}. {err.message}")
            if err.suggestion:
                lines.append(f"     -> 수정 방법: {err.suggestion}")
        lines.append("")

    if warnings:
        lines.append("### 경고 (권장 수정):")
        for i, warn in enumerate(warnings, 1):
            lines.append(f"  {i}. {warn.message}")
            if warn.suggestion:
                lines.append(f"     -> 수정 방법: {warn.suggestion}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Skeleton Validation (Phase 1)
# ---------------------------------------------------------------------------

def validate_skeleton(skeleton) -> ValidationResult:
    """Validate skeleton structure: day count, flights, city transitions, hotels."""
    issues: list[Issue] = []

    # Day count matches
    if len(skeleton.day_allocations) != skeleton.days:
        issues.append(Issue(
            severity=Severity.ERROR,
            day=0,
            message=f"day_allocations({len(skeleton.day_allocations)})와 days({skeleton.days})가 불일치합니다.",
            suggestion="day_allocations 수를 days와 맞추세요.",
        ))

    # Hotel count matches nights
    if len(skeleton.hotels) < skeleton.nights:
        issues.append(Issue(
            severity=Severity.WARNING,
            day=0,
            message=f"호텔({len(skeleton.hotels)}개)이 nights({skeleton.nights})보다 적습니다.",
            suggestion=f"호텔을 {skeleton.nights}개로 설정하세요 (마지막 날 제외).",
        ))

    # City transitions between consecutive days
    DISTANT_PAIRS = {
        frozenset({"도쿄", "오사카"}), frozenset({"도쿄", "후쿠오카"}),
        frozenset({"삿포로", "오사카"}), frozenset({"삿포로", "도쿄"}),
        frozenset({"방콕", "치앙마이"}), frozenset({"하노이", "호치민"}),
        frozenset({"파리", "로마"}), frozenset({"런던", "바르셀로나"}),
    }

    allocs = sorted(skeleton.day_allocations, key=lambda d: d.day)
    for i in range(len(allocs) - 1):
        curr_cities = {c.strip() for c in allocs[i].cities.split(",") if c.strip()}
        next_cities = {c.strip() for c in allocs[i + 1].cities.split(",") if c.strip()}
        for c1 in curr_cities:
            for c2 in next_cities:
                if c1 != c2 and frozenset({c1, c2}) in DISTANT_PAIRS:
                    issues.append(Issue(
                        severity=Severity.WARNING,
                        day=allocs[i].day,
                        message=f"{allocs[i].day}일차→{allocs[i+1].day}일차: {c1}→{c2} 장거리 이동",
                        suggestion="중간 이동일을 배치하거나 인접 도시로 변경하세요.",
                    ))

    # Flight buffer checks (simplified)
    if skeleton.departure_flight.arrival_time and len(allocs) > 0:
        try:
            arr_h, arr_m = map(int, skeleton.departure_flight.arrival_time.split(":"))
            available_start = arr_h + 3
            if available_start >= 22 and len(allocs[0].cities.split(",")) > 1:
                issues.append(Issue(
                    severity=Severity.WARNING, day=1,
                    message="1일차: 도착 후 가용시간이 매우 짧습니다.",
                    suggestion="1일차는 가벼운 일정으로 구성하세요.",
                ))
        except (ValueError, AttributeError):
            pass

    # Score
    errors = [i for i in issues if i.severity == Severity.ERROR]
    warnings = [i for i in issues if i.severity == Severity.WARNING]
    score = max(0, 100 - len(errors) * 15 - len(warnings) * 5)
    passed = score >= 70

    return ValidationResult(
        score=score,
        passed=passed,
        issues=issues,
        correction_guide=_build_correction_guide(issues) if not passed else "",
    )
