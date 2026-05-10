"""Output models for the OTA Travel Planning Agent.

Aligned with Hanatour crawled JSON format so that planned products share
the same schema as real product data.
"""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


# ─── Flight ───

class FlightDetail(BaseModel):
    """Single flight leg in Hanatour format."""

    date: str = Field(default="", description="e.g. 2026.04.01")
    day_of_week: str = Field(default="", description="e.g. 수")
    departure_time: str = Field(default="", description="e.g. 18:50")
    arrival_time: str = Field(default="", description="e.g. 21:35")
    flight_number: str = Field(default="", description="e.g. OZ0755")
    duration: str = Field(default="", description="e.g. 04시간 45분")


# ─── Pricing ───

class Pricing(BaseModel):
    """Pricing block matching Hanatour format."""

    currency: str = Field(default="KRW")
    adult_price: int = Field(default=0, description="Adult price in KRW")
    child_price: int = Field(default=0, description="Child price in KRW")
    infant_price: int = Field(default=0, description="Infant price in KRW")
    fuel_surcharge: int = Field(default=0, description="Fuel surcharge")
    single_room_surcharge: int = Field(default=0, description="Single room surcharge")


# ─── Guide Fee ───

class GuideFee(BaseModel):
    """Guide/driver fee."""

    amount: int = Field(default=0)
    currency: str = Field(default="USD")


# ─── Itinerary ───

class DayItinerary(BaseModel):
    """Single day itinerary in Hanatour format."""

    day: int = Field(..., description="Day number starting from 1")
    date: str = Field(default="", description="e.g. 04/01")
    day_of_week: str = Field(default="", description="e.g. 수")
    cities: str = Field(default="", description="Comma-separated cities, e.g. '다낭, 호이안'")
    attractions: List[str] = Field(default_factory=list, description="Attraction names visited this day")


# ─── Attraction ───

class Attraction(BaseModel):
    """Attraction dictionary entry (top-level attractions list)."""

    name: str = Field(..., description="Attraction name")
    short_description: str = Field(default="", description="One-line description")


# ─── Inclusion / Exclusion ───

class CostItem(BaseModel):
    """Inclusion, exclusion, or optional cost item."""

    category: str = Field(default="")
    detail: str = Field(default="")


# ─── Insurance ───

class Insurance(BaseModel):
    """Travel insurance info."""

    coverage_amount: str = Field(default="")
    medical_limit: str = Field(default="")
    baggage_limit: str = Field(default="")


# ─── Meeting Info ───

class MeetingInfo(BaseModel):
    """Airport meeting information."""

    datetime: str = Field(default="")
    location: str = Field(default="")


# ─── Booking Policy ───

class BookingPolicy(BaseModel):
    """Booking and cancellation policy."""

    deposit_per_person: int = Field(default=0)
    deposit_deadline: str = Field(default="")
    cancellation_policy: str = Field(default="")


# ─── Destination City ───

class DestinationCity(BaseModel):
    """Destination city information."""

    name: str = Field(default="")
    code: str = Field(default="")
    timezone: Optional[str] = Field(default=None)
    voltage: str = Field(default="")
    frequency: str = Field(default="")


# ─── Changes Summary (Agent meta) ───

class ChangesSummary(BaseModel):
    """Summary of what was retained, modified, and added from trend sources."""

    retained: List[str] = Field(default_factory=list, description="Retained elements from reference")
    modified: List[str] = Field(default_factory=list, description="Modified elements")
    trend_added: List[str] = Field(default_factory=list, description="Trend spots inserted")
    similarity_applied: int = Field(default=50, description="Similarity level that was applied")
    layers_modified: List[str] = Field(default_factory=list, description="Layer names that were modified")


# ─── Main Output ───

class PlanningOutput(BaseModel):
    """Complete output aligned with Hanatour JSON format + agent meta fields."""

    # --- Hanatour core fields ---
    product_code: str = Field(default="", description="Server-generated on save. Do NOT generate this field.")
    package_name: str = Field(..., description="Package product name")
    description: str = Field(default="", description="One-paragraph summary")
    hashtags: List[str] = Field(default_factory=list, description="Hashtags")
    rating: float = Field(default=0.0, description="Rating (0 for AI-generated)")
    review_count: int = Field(default=0, description="Review count (0 for AI-generated)")

    nights: int = Field(..., description="Number of nights")
    days: int = Field(..., description="Number of days")
    duration: str = Field(default="", description="e.g. '3박 5일'")

    airline: str = Field(default="", description="Airline name")
    airline_type: str = Field(default="", description="FSC/LCC")

    departure_flight: FlightDetail = Field(default_factory=FlightDetail)
    return_flight: FlightDetail = Field(default_factory=FlightDetail)

    travel_cities: str = Field(default="", description="e.g. '다낭(3)-호이안'")
    city_list: List[str] = Field(default_factory=list, description="List of city names")

    pricing: Pricing = Field(default_factory=Pricing)

    brand: str = Field(
        default="",
        description="v3 Brand vertex name: '세이브' (쇼핑 포함) | '스탠다드' (쇼핑 미포함)",
    )
    # Deprecated — superseded by `brand`. Kept for backward compat.
    shopping_count: int = Field(default=0, description="(deprecated)")
    guide_fee: GuideFee = Field(default_factory=GuideFee)
    product_line: str = Field(default="AI 기획상품", description="Product line")

    highlights: List[str] = Field(default_factory=list, description="Key selling points / highlights")
    hotels: List[str] = Field(default_factory=list, description="Hotel names")

    itinerary: List[DayItinerary] = Field(default_factory=list, description="Day-by-day itinerary")
    attractions: List[Attraction] = Field(default_factory=list, description="Attraction dictionary")

    inclusions: List[CostItem] = Field(default_factory=list)
    exclusions: List[CostItem] = Field(default_factory=list)
    optional_costs: List[CostItem] = Field(default_factory=list)

    insurance: Insurance = Field(default_factory=Insurance)
    meeting_info: MeetingInfo = Field(default_factory=MeetingInfo)
    booking_policy: BookingPolicy = Field(default_factory=BookingPolicy)

    destination_cities: List[DestinationCity] = Field(default_factory=list)

    source_url: str = Field(default="")
    travel_agency: str = Field(default="AI Agent")
    country: str = Field(default="")
    region: str = Field(default="")

    # --- Agent meta fields ---
    similarity_score: int = Field(default=50, description="Requested similarity (slider value).")
    achieved_similarity: int = Field(
        default=0,
        description="Layer-weighted Jaccard score between this output and the reference (0..100).",
    )
    similarity_breakdown: dict = Field(
        default_factory=dict,
        description="Per-layer Jaccard percentages (route/hotel/attraction).",
    )
    reference_products: List[str] = Field(default_factory=list, description="Reference product codes")
    changes_summary: ChangesSummary = Field(default_factory=ChangesSummary)
    graph_trace: List[dict] = Field(
        default_factory=list,
        description="Knowledge Graph 도구 호출 트레이스 (tool/arguments/queries/rows/latency_ms)",
    )
    trend_sources: List[str] = Field(default_factory=list, description="(deprecated)")
    generated_at: str = Field(default="", description="Server-generated on save. Do NOT generate this field.")
    generated_by: str = Field(default="ai-agent", description="Server-generated on save. Do NOT generate this field.")


# ─── Phase 1: Skeleton Output ───

class SkeletonDayAllocation(BaseModel):
    """Single day in the skeleton: city assignment only, no attraction details."""

    day: int = Field(..., description="Day number starting from 1")
    date: str = Field(default="", description="e.g. 04/01")
    day_of_week: str = Field(default="", description="e.g. 수")
    cities: str = Field(default="", description="Comma-separated cities for this day")


class SkeletonOutput(BaseModel):
    """Phase 1 output: travel structure (final slim).

    Owns only the grounded routing facts: nights/days/cities/flights/
    hotels/brand/similarity_score/reference_products. Everything else
    is decided post-aggregate by :class:`SynthesizeOutput` or filled
    deterministically by :mod:`src.synthesis.business_meta`.
    """

    nights: int = Field(..., description="Number of nights")
    days: int = Field(..., description="Number of days")

    airline: str = Field(default="", description="Airline name")
    departure_flight: FlightDetail = Field(default_factory=FlightDetail)
    return_flight: FlightDetail = Field(default_factory=FlightDetail)

    travel_cities: str = Field(default="", description="e.g. '오사카(2)-교토'")
    city_list: List[str] = Field(default_factory=list, description="City names")
    hotels: List[str] = Field(default_factory=list, description="Hotel names per night")
    day_allocations: List[SkeletonDayAllocation] = Field(default_factory=list, description="City assignment per day")

    brand: str = Field(default="", description="v3 Brand: '세이브' or '스탠다드'")

    similarity_score: int = Field(default=50)
    reference_products: List[str] = Field(default_factory=list)


class SynthesizeOutput(BaseModel):
    """LLM output that runs after day_details PASS.

    Stage 4 scope: all the day-aware judgment fields. SynthesizeNode
    splats these onto the merged ``PlanningOutput``. The agent must
    not change cities / hotels / flights / itinerary — those are
    grounded by skeleton + day workers.
    """

    package_name: str = Field(..., description="상품명 (테마/시즌 반영)")
    description: str = Field(default="", description="1문단 요약")
    hashtags: List[str] = Field(
        default_factory=list, description="해시태그 (각 항목은 # 포함 또는 미포함 모두 OK)"
    )
    highlights: List[str] = Field(
        default_factory=list,
        description="대표 셀링 포인트 5-8줄. 실제 itinerary 의 명소/도시 기반.",
    )
    pricing: Pricing = Field(
        default_factory=Pricing,
        description="similar.candidates 가격을 anchor 로. invent 금지.",
    )
    inclusions: List[CostItem] = Field(
        default_factory=list,
        description="실 itinerary 와 항공편 기반. 일정에 없는 도시/명소 언급 금지.",
    )
    exclusions: List[CostItem] = Field(default_factory=list)
    optional_costs: List[CostItem] = Field(
        default_factory=list,
        description="itinerary 의 명소·hotel 인근 옵션만. itinerary 외 명소 추가 금지.",
    )
    changes_summary: ChangesSummary = Field(
        default_factory=ChangesSummary,
        description="reference 대비 무엇을 유지/변경했는지.",
    )


# ─── Phase 2: Day Detail Output ───

class DayDetailOutput(BaseModel):
    """Phase 2 output: detailed itinerary for a single day."""

    day: int = Field(..., description="Day number")
    date: str = Field(default="", description="e.g. 04/01")
    day_of_week: str = Field(default="", description="e.g. 수")
    cities: str = Field(default="", description="Cities visited this day")
    attractions: List[str] = Field(default_factory=list, description="Attraction names in visit order")
    attraction_details: List[Attraction] = Field(default_factory=list, description="Name + description for each attraction")
    highlights: List[str] = Field(default_factory=list, description="Day-specific highlights (1-2 lines)")
    trend_spots_used: List[str] = Field(default_factory=list, description="이 날짜에 삽입된 트렌드 스팟 이름")


# ─── Merge Function ───

def merge_skeleton_and_days(
    skeleton: SkeletonOutput,
    day_details: List[DayDetailOutput],
    planning_input: dict | None = None,
) -> PlanningOutput:
    """Assemble a complete PlanningOutput from skeleton + day details.

    Stage 1 of the Skeleton-slim refactor: business-meta fields
    (meeting_info, booking_policy, insurance, guide_fee,
    destination_cities, country, region, airline_type, duration, …) are
    no longer carried on ``skeleton``. They're filled here from
    :func:`src.synthesis.business_meta.fill_business_meta`, which only
    consumes deterministic inputs (depart-airport hint, airline code,
    city list).
    """
    # Local import keeps the model layer free of synthesis-side deps when
    # mypy / pyright analyses output.py in isolation.
    from src.synthesis.business_meta import fill_business_meta

    itinerary: List[DayItinerary] = []
    all_attractions: List[Attraction] = []
    all_highlights: List[str] = []
    all_trend_spots: List[str] = []

    for detail in sorted(day_details, key=lambda d: d.day):
        itinerary.append(DayItinerary(
            day=detail.day,
            date=detail.date,
            day_of_week=detail.day_of_week,
            cities=detail.cities,
            attractions=detail.attractions,
        ))
        all_attractions.extend(detail.attraction_details)
        all_highlights.extend(detail.highlights)
        all_trend_spots.extend(detail.trend_spots_used)

    # Deduplicate attractions by name
    seen: set[str] = set()
    unique_attractions: List[Attraction] = []
    for attr in all_attractions:
        if attr.name not in seen:
            seen.add(attr.name)
            unique_attractions.append(attr)

    # Aggregate trend info from day details (order-preserving dedup)
    unique_trends = list(dict.fromkeys(all_trend_spots))

    business_meta = fill_business_meta(planning_input or {}, skeleton)

    # Stage 3: package_name / description / hashtags / changes_summary
    # are filled by SynthesizeNode. Provide safe placeholders here so
    # the model validates if synthesize is somehow skipped.
    placeholder_changes = ChangesSummary(
        trend_added=unique_trends,
        similarity_applied=skeleton.similarity_score,
    )
    placeholder_name = (
        f"{'-'.join(skeleton.city_list[:3])} {skeleton.nights}박 {skeleton.days}일"
        if skeleton.city_list
        else "AI 기획 상품"
    )

    return PlanningOutput(
        package_name=placeholder_name,
        description="",
        hashtags=[],
        nights=skeleton.nights,
        days=skeleton.days,
        airline=skeleton.airline,
        departure_flight=skeleton.departure_flight,
        return_flight=skeleton.return_flight,
        travel_cities=skeleton.travel_cities,
        city_list=skeleton.city_list,
        pricing=Pricing(),  # filled by SynthesizeNode
        brand=skeleton.brand,
        hotels=skeleton.hotels,
        itinerary=itinerary,
        attractions=unique_attractions,
        highlights=all_highlights[:10],
        inclusions=[],  # filled by SynthesizeNode
        exclusions=[],
        optional_costs=[],
        similarity_score=skeleton.similarity_score,
        reference_products=skeleton.reference_products,
        changes_summary=placeholder_changes,
        trend_sources=unique_trends,
        **business_meta,
    )
