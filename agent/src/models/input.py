"""Input models for the OTA Travel Planning Agent."""

from typing import List, Optional

from pydantic import BaseModel, Field


class Duration(BaseModel):
    """Travel duration expressed as nights and days."""

    nights: int = Field(..., ge=1, description="Number of nights")
    days: int = Field(..., ge=1, description="Number of days")


class PlanningInput(BaseModel):
    """Unified input schema accepted from both chat (Mode A) and form (Mode B) interfaces."""

    destination: str = Field(..., description="Travel destination, e.g. '일본 오사카'")
    duration: Duration = Field(..., description="Trip duration as nights/days")
    departure_season: str = Field(..., description="Departure season, e.g. '봄', '여름', '가을', '겨울'")
    similarity_level: int = Field(
        default=50,
        ge=0,
        le=100,
        description="Similarity dial 0-100. 100 = nearly identical to reference, 0 = completely new.",
    )
    reference_product_id: Optional[str] = Field(
        default=None,
        description="Optional reference package code to base the new package on.",
    )
    themes: List[str] = Field(default_factory=list, description="Selected themes, e.g. ['미식', '문화']")
    natural_language_request: str = Field(
        default="",
        description="Free-text additional requirements from the MD.",
    )
    target_customer: str = Field(default="", description="Target customer segment, e.g. '30대 커플'")
    max_budget_per_person: Optional[int] = Field(
        default=None,
        description="Maximum budget per person in KRW.",
    )
    max_shopping_count: Optional[int] = Field(
        default=None,
        description="Maximum allowed shopping stops.",
    )
    meal_preference: Optional[str] = Field(
        default=None,
        description="Meal preference, e.g. '전식 포함', '자유식'.",
    )
    hotel_grade: Optional[str] = Field(
        default=None,
        description="Desired hotel grade, e.g. '5성급', '료칸', '비즈니스'.",
    )
    input_mode: str = Field(
        default="form",
        description="Input mode: 'chat' for natural language, 'form' for structured form.",
    )
