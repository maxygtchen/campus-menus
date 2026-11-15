"""
Normalized data model shared by every school.

Each school scraper turns its own source (Berkeley's XML, another school's
Nutrislice API, etc.) into these same objects, so the app only ever has to
understand one format.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Optional


@dataclass
class Nutrition:
    kcal: Optional[float] = None
    protein_g: Optional[float] = None
    carbs_g: Optional[float] = None
    fat_g: Optional[float] = None
    fiber_g: Optional[float] = None
    sugar_g: Optional[float] = None
    sodium_mg: Optional[float] = None
    serving: str = ""  # e.g. "5.54 oz"


@dataclass
class MenuItem:
    name: str
    station: str                      # e.g. "Center Plate", "Salad Bar"
    station_type: str                 # "main" | "side" | "bar" | "dessert"
    dish_key: str                     # stable across days, used for ratings
    nutrition: Nutrition
    allergens: list[str] = field(default_factory=list)   # "milk", "egg", ...
    diets: list[str] = field(default_factory=list)       # "vegan", "halal", ...
    tags: list[str] = field(default_factory=list)        # "high_protein", ...
    carbon_kg: Optional[float] = None
    source_id: str = ""


@dataclass
class Meal:
    period: str              # "Breakfast" | "Brunch" | "Lunch" | "Dinner" | "All Day"
    raw_period: str          # as the school labels it, e.g. "Fall - Brunch"
    start: Optional[str]     # "11:00" (local time)
    end: Optional[str]       # "16:00"
    items: list[MenuItem] = field(default_factory=list)


@dataclass
class Location:
    name: str
    kind: str                # "dining_hall" | "market" | "restaurant"
    meals: list[Meal] = field(default_factory=list)


@dataclass
class DayMenu:
    school: str              # "berkeley"
    date: str                # "2026-11-15"
    scraped_at: str          # ISO timestamp
    timezone: str            # "America/Los_Angeles"
    locations: list[Location] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    def item_count(self) -> int:
        return sum(len(m.items) for loc in self.locations for m in loc.meals)


def make_dish_key(school: str, name: str) -> str:
    """
    A stable key for "the same dish" across days and dining halls.

    Menus run on a rotation, so the same dish comes back every few weeks.
    Keying ratings on this lets the app predict tonight's dining hall score
    from past ratings of the dishes being served.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return f"{school}:{slug}"
