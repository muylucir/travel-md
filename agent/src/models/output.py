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

    shopping_count: int = Field(default=0)
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
    similarity_score: int = Field(default=50, description="Similarity score applied")
    reference_products: List[str] = Field(default_factory=list, description="Reference product codes")
    changes_summary: ChangesSummary = Field(default_factory=ChangesSummary)
    trend_sources: List[str] = Field(default_factory=list, description="Trend sources referenced")
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
    """Phase 1 output: travel structure without per-day attraction details."""

    package_name: str = Field(..., description="Package product name")
    description: str = Field(default="", description="One-paragraph summary")
    nights: int = Field(..., description="Number of nights")
    days: int = Field(..., description="Number of days")
    duration: str = Field(default="", description="e.g. '3박 4일'")

    airline: str = Field(default="", description="Airline name")
    airline_type: str = Field(default="", description="FSC/LCC")
    departure_flight: FlightDetail = Field(default_factory=FlightDetail)
    return_flight: FlightDetail = Field(default_factory=FlightDetail)

    travel_cities: str = Field(default="", description="e.g. '오사카(2)-교토'")
    city_list: List[str] = Field(default_factory=list, description="City names")
    hotels: List[str] = Field(default_factory=list, description="Hotel names per night")
    day_allocations: List[SkeletonDayAllocation] = Field(default_factory=list, description="City assignment per day")

    pricing: Pricing = Field(default_factory=Pricing)
    shopping_count: int = Field(default=0)
    guide_fee: GuideFee = Field(default_factory=GuideFee)

    country: str = Field(default="")
    region: str = Field(default="")
    similarity_score: int = Field(default=50)
    reference_products: List[str] = Field(default_factory=list)

    inclusions: List[CostItem] = Field(default_factory=list)
    exclusions: List[CostItem] = Field(default_factory=list)
    optional_costs: List[CostItem] = Field(default_factory=list)
    insurance: Insurance = Field(default_factory=Insurance)
    meeting_info: MeetingInfo = Field(default_factory=MeetingInfo)
    booking_policy: BookingPolicy = Field(default_factory=BookingPolicy)
    destination_cities: List[DestinationCity] = Field(default_factory=list)

    changes_summary: ChangesSummary = Field(default_factory=ChangesSummary)


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


# ─── Merge Function ───

def merge_skeleton_and_days(
    skeleton: SkeletonOutput,
    day_details: List[DayDetailOutput],
) -> PlanningOutput:
    """Assemble a complete PlanningOutput from skeleton + day details."""
    itinerary: List[DayItinerary] = []
    all_attractions: List[Attraction] = []
    all_highlights: List[str] = []

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

    # Deduplicate attractions by name
    seen: set[str] = set()
    unique_attractions: List[Attraction] = []
    for attr in all_attractions:
        if attr.name not in seen:
            seen.add(attr.name)
            unique_attractions.append(attr)

    return PlanningOutput(
        package_name=skeleton.package_name,
        description=skeleton.description,
        nights=skeleton.nights,
        days=skeleton.days,
        duration=skeleton.duration,
        airline=skeleton.airline,
        airline_type=skeleton.airline_type,
        departure_flight=skeleton.departure_flight,
        return_flight=skeleton.return_flight,
        travel_cities=skeleton.travel_cities,
        city_list=skeleton.city_list,
        pricing=skeleton.pricing,
        shopping_count=skeleton.shopping_count,
        guide_fee=skeleton.guide_fee,
        hotels=skeleton.hotels,
        itinerary=itinerary,
        attractions=unique_attractions,
        highlights=all_highlights[:10],
        inclusions=skeleton.inclusions,
        exclusions=skeleton.exclusions,
        optional_costs=skeleton.optional_costs,
        insurance=skeleton.insurance,
        meeting_info=skeleton.meeting_info,
        booking_policy=skeleton.booking_policy,
        destination_cities=skeleton.destination_cities,
        country=skeleton.country,
        region=skeleton.region,
        similarity_score=skeleton.similarity_score,
        reference_products=skeleton.reference_products,
        changes_summary=skeleton.changes_summary,
    )
