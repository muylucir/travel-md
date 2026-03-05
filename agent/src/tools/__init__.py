from src.tools.get_package import get_package
from src.tools.search_packages import search_packages
from src.tools.get_routes import get_routes_by_region
from src.tools.get_attractions import get_attractions_by_city
from src.tools.get_hotels import get_hotels_by_city
from src.tools.get_trends import get_trends
from src.tools.get_similar import get_similar_packages
from src.tools.get_nearby_cities import get_nearby_cities

ALL_TOOLS = [
    get_package,
    search_packages,
    get_routes_by_region,
    get_attractions_by_city,
    get_hotels_by_city,
    get_trends,
    get_similar_packages,
    get_nearby_cities,
]

__all__ = [
    "get_package",
    "search_packages",
    "get_routes_by_region",
    "get_attractions_by_city",
    "get_hotels_by_city",
    "get_trends",
    "get_similar_packages",
    "get_nearby_cities",
    "ALL_TOOLS",
]
