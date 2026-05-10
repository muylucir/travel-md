"""Deterministic business-meta filler for PlanningOutput.

Several PlanningOutput fields are pure templates of the user's input
(e.g. depart airport → meeting_info, airline code → FSC/LCC) or
constants (e.g. travel_agency = "AI Agent"). Letting the LLM generate
these values is the source of confused or fabricated data
("Incheon Terminal 3" — there is no Terminal 3). This module owns those
fields so they never reach an LLM prompt.

The single entry point is :func:`fill_business_meta`, which takes the
parsed planning input and the (slimmed) skeleton and returns a dict of
field-name -> Pydantic model ready to splat into ``PlanningOutput``.
"""

from __future__ import annotations

from typing import Any

from src.models.output import (
    BookingPolicy,
    DestinationCity,
    GuideFee,
    Insurance,
    MeetingInfo,
)


# ---------------------------------------------------------------------------
# Static templates
# ---------------------------------------------------------------------------

# Airline code (IATA) → FSC/LCC tier. Codes appear in our graph routes.
# Default to "FSC" only for the canonical full-service carriers; everything
# else (low-cost / regional) is "LCC". Unknown codes return "" so the field
# is honest about uncertainty rather than guessing.
_AIRLINE_TYPE: dict[str, str] = {
    "KE": "FSC",   # Korean Air
    "OZ": "FSC",   # Asiana
    "JL": "FSC",   # JAL
    "NH": "FSC",   # ANA
    "CX": "FSC",   # Cathay Pacific
    "SQ": "FSC",   # Singapore Airlines
    # LCC explicit (some travellers only recognise these as LCC)
    "7C": "LCC",   # Jeju Air
    "TW": "LCC",   # T'way
    "BX": "LCC",   # Air Busan
    "ZE": "LCC",   # Eastar
    "LJ": "LCC",   # Jin Air
    "RS": "LCC",   # Air Seoul
    "RF": "LCC",   # Aero K
    "YP": "LCC",   # Air Premia
    "4V": "LCC",   # Fly Gangwon
}

_AIRPORT_NAMES: dict[str, str] = {
    "ICN": "인천국제공항 제1터미널",
    "GMP": "김포국제공항 국제선 청사",
    "PUS": "김해국제공항 국제선 청사",
    "TAE": "대구국제공항 국제선 청사",
    "CJU": "제주국제공항 국제선 청사",
    "CJJ": "청주국제공항 국제선 청사",
    "MWX": "무안국제공항 국제선 청사",
    "YNY": "양양국제공항 국제선 청사",
}

# Most outbound flights to KIX/NRT/etc. have a recommended 2.5-hour
# pre-departure check-in for international travel.
_DEFAULT_CHECKIN_LEAD_MIN = 150


# Arrival airport code (IATA) → DestinationCity defaults.
# Used for `country`, timezone, voltage, etc. when we know the target
# airport. New regions get added here, not in the LLM prompt.
_DESTINATION_DEFAULTS: dict[str, dict[str, Any]] = {
    "KIX": {
        "code": "KIX",
        "country": "일본",
        "region": "간사이",
        "timezone": "Asia/Tokyo",
        "voltage": "100V/50Hz",
    },
    "NRT": {
        "code": "NRT",
        "country": "일본",
        "region": "간토",
        "timezone": "Asia/Tokyo",
        "voltage": "100V/50Hz",
    },
    "HND": {
        "code": "HND",
        "country": "일본",
        "region": "간토",
        "timezone": "Asia/Tokyo",
        "voltage": "100V/50Hz",
    },
    "FUK": {
        "code": "FUK",
        "country": "일본",
        "region": "큐슈",
        "timezone": "Asia/Tokyo",
        "voltage": "100V/50Hz",
    },
    "CTS": {
        "code": "CTS",
        "country": "일본",
        "region": "홋카이도",
        "timezone": "Asia/Tokyo",
        "voltage": "100V/50Hz",
    },
}

# Region inference fallback when we don't know the arrival airport but do
# know the destination cities. Keep this tight (Kansai is the only region
# the v3 graph currently ships).
_KANSAI_CITIES = {"오사카", "교토", "고베", "나라"}
_KANTO_CITIES = {"도쿄", "요코하마", "지바", "사이타마"}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def derive_airline_type(airline_code: str) -> str:
    """Return ``"FSC"`` / ``"LCC"`` from an IATA code.

    Returns ``""`` for unknown codes so callers can decide whether to
    surface an empty value (preferred) or fabricate one (no).
    """
    if not airline_code:
        return ""
    return _AIRLINE_TYPE.get(airline_code.strip().upper(), "")


def derive_duration(nights: int, days: int) -> str:
    """Render the canonical ``"3박 4일"`` string."""
    if nights <= 0 or days <= 0:
        return ""
    return f"{nights}박 {days}일"


def derive_region(country: str, cities: list[str]) -> str:
    """Best-effort region inference from country + city set.

    Falls back to the country name when no specific region matches.
    """
    city_set = {c.strip() for c in (cities or []) if c}
    if city_set & _KANSAI_CITIES:
        return "간사이"
    if city_set & _KANTO_CITIES:
        return "간토"
    return country or ""


def derive_country(arrival_airport: str, fallback: str = "") -> str:
    info = _DESTINATION_DEFAULTS.get((arrival_airport or "").upper())
    if info:
        return str(info.get("country", fallback))
    return fallback


def build_meeting_info(depart_airport: str, departure_time: str) -> MeetingInfo:
    """Compose the airport meeting block from the depart airport & time.

    The check-in instruction is conservative (2h30m before departure) and
    explicit about which airport/terminal — preventing ad-hoc strings like
    "제3터미널" from sneaking into the saved product.
    """
    code = (depart_airport or "ICN").upper()
    location = _AIRPORT_NAMES.get(code, f"{code} 국제선 청사")
    if departure_time and ":" in departure_time:
        try:
            hh, mm = (int(x) for x in departure_time.split(":")[:2])
            total = hh * 60 + mm - _DEFAULT_CHECKIN_LEAD_MIN
            total %= 24 * 60
            datetime_str = f"출발 2시간 30분 전 ({total // 60:02d}:{total % 60:02d})"
        except (ValueError, TypeError):
            datetime_str = "출발 2시간 30분 전"
    else:
        datetime_str = "출발 2시간 30분 전"
    return MeetingInfo(datetime=datetime_str, location=location)


def build_destination_cities(
    arrival_airport: str, cities: list[str]
) -> list[DestinationCity]:
    """One DestinationCity per visited city, populated from a defaults table."""
    base = _DESTINATION_DEFAULTS.get((arrival_airport or "").upper(), {})
    code = base.get("code", "")
    timezone = base.get("timezone")
    voltage = base.get("voltage", "")
    return [
        DestinationCity(
            name=name,
            code=code,
            timezone=timezone,
            voltage=voltage,
            frequency="",
        )
        for name in (cities or [])
        if name
    ]


_DEFAULT_BOOKING_POLICY = BookingPolicy(
    deposit_per_person=100_000,
    deposit_deadline="출발 60일 전",
    cancellation_policy="출발 60일 이전 취소 시 환불 가능 / 30일 이내 취소 위약금 발생",
)

_DEFAULT_INSURANCE = Insurance(
    coverage_amount="최대 1억원",
    medical_limit="3,000만원",
    baggage_limit="50만원",
)

_DEFAULT_GUIDE_FEE = GuideFee(amount=5, currency="USD")


def fill_business_meta(
    planning_input: dict, skeleton: Any
) -> dict[str, Any]:
    """Return the deterministic field set for a PlanningOutput.

    Args:
        planning_input: dict form of :class:`PlanningInput` (taken from
            ``invocation_state["planning_input_parsed"]``). Used for the
            depart-airport hint.
        skeleton: the (slim) :class:`SkeletonOutput`. Used for arrival
            airport, airline, duration, and visited cities.

    The returned mapping is a kwargs blob: every key is a valid
    PlanningOutput attribute, ready to overwrite values on the merged
    output during :func:`merge_skeleton_and_days`.
    """
    depart_airport = ""
    arrival_airport = ""
    departure_time = ""
    airline_code = ""
    cities: list[str] = []
    nights = 0
    days = 0

    if skeleton is not None:
        dep = getattr(skeleton, "departure_flight", None)
        ret = getattr(skeleton, "return_flight", None)
        if dep is not None:
            airline_code = (getattr(dep, "flight_number", "") or "")[:2]
            departure_time = getattr(dep, "departure_time", "") or ""
        if ret is not None:
            # Return flight tells us where we flew back from → arrival airport
            ret_no = (getattr(ret, "flight_number", "") or "")
            if not airline_code and ret_no:
                airline_code = ret_no[:2]
        cities = list(getattr(skeleton, "city_list", None) or [])
        nights = int(getattr(skeleton, "nights", 0) or 0)
        days = int(getattr(skeleton, "days", 0) or 0)

    # Depart airport: prefer planning_input hint if present, otherwise
    # fall back to the well-known ICN default.
    if isinstance(planning_input, dict):
        depart_airport = (
            planning_input.get("depart_airport")
            or planning_input.get("departure_airport")
            or ""
        )

    # Arrival airport: pull from FlightDetail.flight_number prefix table is
    # unreliable (we only know airline code). Use destination → KIX default
    # for now; production code can plug in a richer mapping.
    arrival_airport = "KIX" if cities and (set(cities) & _KANSAI_CITIES) else ""

    country = derive_country(arrival_airport, fallback="일본" if arrival_airport == "KIX" else "")
    region = derive_region(country, cities)

    return {
        "duration": derive_duration(nights, days),
        "airline_type": derive_airline_type(airline_code),
        "country": country,
        "region": region,
        "meeting_info": build_meeting_info(depart_airport or "ICN", departure_time),
        "booking_policy": _DEFAULT_BOOKING_POLICY.model_copy(),
        "insurance": _DEFAULT_INSURANCE.model_copy(),
        "guide_fee": _DEFAULT_GUIDE_FEE.model_copy(),
        "destination_cities": build_destination_cities(arrival_airport, cities),
        "travel_agency": "AI Agent",
        "product_line": "AI 기획상품",
        "rating": 0.0,
        "review_count": 0,
        "shopping_count": 0,
        "source_url": "",
    }
