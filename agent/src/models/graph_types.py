"""Graph node type definitions for Neptune Knowledge Graph entities."""

from typing import List, TypedDict

try:
    from typing import NotRequired
except ImportError:
    from typing_extensions import NotRequired


class PackageNode(TypedDict):
    """Package node from the Knowledge Graph."""

    code: str
    name: str
    description: NotRequired[str]
    price: int
    child_price: NotRequired[int]
    infant_price: NotRequired[int]
    nights: int
    days: int
    rating: NotRequired[float]
    review_count: NotRequired[int]
    season: NotRequired[List[str]]
    product_line: NotRequired[str]
    hashtags: NotRequired[List[str]]
    source_url: NotRequired[str]
    shopping_count: NotRequired[int]
    has_escort: NotRequired[bool]
    guide_fee: NotRequired[str]
    meal_included: NotRequired[str]
    optional_tour: NotRequired[bool]
    single_room_surcharge: NotRequired[int]
    deposit_per_person: NotRequired[int]


class CityNode(TypedDict):
    """City node from the Knowledge Graph."""

    name: str
    country: NotRequired[str]
    region: NotRequired[str]
    code: NotRequired[str]
    timezone: NotRequired[str]
    voltage: NotRequired[str]
    size: NotRequired[str]


class AttractionNode(TypedDict):
    """Attraction node from the Knowledge Graph."""

    name: str
    category: NotRequired[str]
    description: NotRequired[str]
    family_friendly: NotRequired[bool]
    photo_worthy: NotRequired[bool]


class HotelNode(TypedDict):
    """Hotel node from the Knowledge Graph."""

    name_ko: NotRequired[str]
    name_en: str
    grade: NotRequired[str]
    room_type: NotRequired[str]
    has_onsen: NotRequired[bool]
    amenities: NotRequired[str]
    description: NotRequired[str]


class RouteNode(TypedDict):
    """Route (flight route) node from the Knowledge Graph."""

    id: str
    departure_city: str
    arrival_city: str
    airline: str
    airline_type: NotRequired[str]
    flight_number: str
    departure_time: str
    arrival_time: str
    duration: str


class TrendNode(TypedDict):
    """Trend node from the Knowledge Graph."""

    id: str
    title: str
    type: str
    source: NotRequired[str]
    date: NotRequired[str]
    virality_score: int
    decay_rate: float
    keywords: NotRequired[List[str]]


class TrendSpotNode(TypedDict):
    """TrendSpot node from the Knowledge Graph."""

    name: str
    description: NotRequired[str]
    category: NotRequired[str]
    lat: NotRequired[float]
    lng: NotRequired[float]
    photo_worthy: NotRequired[bool]
