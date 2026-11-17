"""
Fill gaps Berkeley's daily XML leaves out.

The export is meal-specific: Crossroads breakfast may list only Center Plate,
while the same hall's lunch JSON has a full Salad Bar. All-day stations also
don't appear at every hall/meal. Berkeley does not publish beverages in XML at all.

After parsing a location we:
  1. Copy the richest set of bar/salad/fruit/yogurt items onto every meal
     at that hall (deduped by dish + station).
  2. Append the curated beverage list (dining halls only).
"""
from __future__ import annotations

import json
import logging
from copy import deepcopy
from pathlib import Path
from typing import Iterable

from .models import Location, Meal, MenuItem, Nutrition
from .tags import apply_tags, classify_station

log = logging.getLogger(__name__)

# Station names vary by hall; group by keyword.
_BAR_GROUPS: list[tuple[str, tuple[str, ...]]] = [
    ("salad", ("salad bar", "ladle and leaf - salad", "salad bowl")),
    ("deli", ("deli bar",)),
    ("cold", ("cold food bar",)),
    ("fruit", ("fresh fruit", "fruit bar")),
    ("yogurt", ("yogurt",)),
]

_BEVERAGES_PATH = Path(__file__).resolve().parent / "data" / "berkeley" / "beverages.json"
_beverage_cache: list[MenuItem] | None = None


def _station_group(station: str) -> str | None:
    s = station.lower()
    for key, words in _BAR_GROUPS:
        if any(w in s for w in words):
            return key
    return None


def _item_key(item: MenuItem) -> tuple[str, str]:
    return (item.dish_key, item.station.lower())


def _best_pool(meals: Iterable[Meal]) -> dict[str, list[MenuItem]]:
    """For each bar group, keep the longest item list seen in any meal."""
    pool: dict[str, list[MenuItem]] = {}
    best_n: dict[str, int] = {}
    for meal in meals:
        by_group: dict[str, list[MenuItem]] = {}
        for item in meal.items:
            g = _station_group(item.station)
            if g is None:
                continue
            by_group.setdefault(g, []).append(item)
        for g, items in by_group.items():
            if len(items) > best_n.get(g, 0):
                best_n[g] = len(items)
                pool[g] = items
    return pool


def _meal_has_group(meal: Meal, group: str) -> bool:
    return any(_station_group(i.station) == group for i in meal.items)


def _load_beverages() -> list[MenuItem]:
    global _beverage_cache
    if _beverage_cache is not None:
        return _beverage_cache
    if not _BEVERAGES_PATH.is_file():
        _beverage_cache = []
        return _beverage_cache
    raw = json.loads(_BEVERAGES_PATH.read_text(encoding="utf-8"))
    out: list[MenuItem] = []
    for row in raw.get("items", []):
        row = dict(row)
        nut = Nutrition(**row.pop("nutrition"))
        station = row.pop("station", "Beverages")
        item = MenuItem(
            name=row["name"],
            station=station,
            station_type=classify_station(station),
            dish_key=row["dish_key"],
            nutrition=nut,
            allergens=row.get("allergens", []),
            diets=row.get("diets", []),
            tags=row.get("tags", []),
            carbon_kg=row.get("carbon_kg"),
            source_id=row.get("source_id", ""),
        )
        out.append(apply_tags(item))
    _beverage_cache = out
    return out


def enrich_location(loc: Location) -> int:
    """Add missing always-on station items. Returns count of items added."""
    if not loc.meals:
        return 0
    pool = _best_pool(loc.meals)
    added = 0

    for meal in loc.meals:
        present = {_item_key(i) for i in meal.items}
        for group, items in pool.items():
            if _meal_has_group(meal, group):
                continue
            for item in items:
                key = _item_key(item)
                if key in present:
                    continue
                meal.items.append(deepcopy(item))
                present.add(key)
                added += 1

    if loc.kind == "dining_hall":
        bevs = _load_beverages()
        for meal in loc.meals:
            present = {_item_key(i) for i in meal.items}
            for item in bevs:
                key = _item_key(item)
                if key in present:
                    continue
                meal.items.append(deepcopy(item))
                present.add(key)
                added += 1

    if added:
        log.debug("%s: added %d always-available items", loc.name, added)
    return added