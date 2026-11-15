"""
Simple, school-independent tagging rules.

Kept deliberately plain and non-judgmental: tags describe what fits a goal
("high protein"), never what is "bad". Tweak thresholds here in one place.
"""
from __future__ import annotations

from .models import MenuItem

HIGH_PROTEIN_MIN_G = 20      # per serving
LIGHTER_MAX_KCAL = 400       # only applied to main dishes

# Station names are free text and differ by school, so classify by keyword.
_BAR_WORDS = ("salad", "deli", "yogurt", "topping", "condiment", "dressing",
              "cereal", "fruit", "bread", "bagel", "beverage", "drink")
_DESSERT_WORDS = ("dessert", "soft serve", "bakery", "sweet", "pastr")
_SIDE_WORDS = ("soup", "hot grains", "appetizer", "side")


def classify_station(station: str) -> str:
    s = station.lower()
    if any(w in s for w in _DESSERT_WORDS):
        return "dessert"
    if any(w in s for w in _BAR_WORDS):
        return "bar"
    if any(w in s for w in _SIDE_WORDS):
        return "side"
    return "main"


def apply_tags(item: MenuItem) -> MenuItem:
    tags: list[str] = []
    n = item.nutrition
    if n.protein_g is not None and n.protein_g >= HIGH_PROTEIN_MIN_G:
        tags.append("high_protein")
    if (item.station_type == "main" and n.kcal is not None
            and 0 < n.kcal <= LIGHTER_MAX_KCAL):
        tags.append("lighter")
    if "vegan" in item.diets:
        tags.append("vegan")
    elif "vegetarian" in item.diets:
        tags.append("vegetarian")
    item.tags = tags
    return item
