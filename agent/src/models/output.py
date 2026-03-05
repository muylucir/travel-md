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
