"""
UC Irvine Dining scraper (MyDiningHub / Adobe Elevate GraphQL).

Public GraphQL mesh (same one the campus site and Anteater API use):
  https://api.elevate-dxp.com/api/mesh/<id>/graphql

Halls: The Anteatery, Brandywine, The Oasis (when menus exist).
"""
from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime
from typing import Any, Optional
from urllib.parse import quote
from zoneinfo import ZoneInfo

import requests

from ..models import DayMenu, Location, Meal, MenuItem, Nutrition, make_dish_key
from ..tags import apply_tags, classify_station

log = logging.getLogger(__name__)

SCHOOL = "uci"
TIMEZONE = "America/Los_Angeles"
GRAPHQL = (
    "https://api.elevate-dxp.com/api/mesh/"
    "c087f756-cc72-4649-a36f-3a41b700c519/graphql"
)
REQUEST_DELAY_S = 0.35

HALLS = [
    ("the-anteatery", "The Anteatery"),
    ("brandywine", "Brandywine"),
    ("the-oasis-dining-hall", "The Oasis"),
]

HEADERS = {
    "User-Agent": "campus-menus/0.1 (student project; contact: YOUR_EMAIL)",
    "Referer": "https://uci.mydininghub.com/",
    "Origin": "https://uci.mydininghub.com",
    "content-type": "application/json",
    "store": "ch_uci_en",
    "magento-store-code": "ch_uci",
    "magento-website-code": "ch_uci",
    "magento-store-view-code": "ch_uci_en",
    "x-api-key": "ElevateAPIProd",
}

ALLERGEN_STATEMENT = {
    "milk": "milk", "egg": "egg", "eggs": "egg", "fish": "fish",
    "shellfish": "shellfish", "peanut": "peanuts", "peanuts": "peanuts",
    "tree nut": "tree_nuts", "tree nuts": "tree_nuts", "soy": "soy",
    "wheat": "wheat", "sesame": "sesame", "gluten": "gluten",
}

DEFAULT_HOURS = {
    "Breakfast": ("07:15", "11:00"),
    "Brunch": ("10:00", "14:00"),
    "Lunch": ("11:00", "14:30"),
    "Dinner": ("16:30", "20:30"),
    "Late Night": ("20:30", "23:00"),
    "All Day": ("07:00", "22:00"),
}


def _num(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return round(float(str(v).strip()), 1)
    except ValueError:
        return None


def normalize_period(name: str) -> Optional[str]:
    r = name.lower()
    if "snack" in r or "overnight" in r or "limited" in r:
        return None  # skip snack / limited variants for the main app
    for word, label in (("breakfast", "Breakfast"), ("brunch", "Brunch"),
                        ("lunch", "Lunch"), ("dinner", "Dinner"),
                        ("late", "Late Night"), ("all day", "All Day")):
        if word in r:
            return label
    return None


def gql(session: requests.Session, query: str, variables: dict) -> Optional[dict]:
    url = f"{GRAPHQL}?query={quote(query)}&variables={quote(json.dumps(variables))}"
    for attempt in range(2):
        try:
            r = session.get(url, headers=HEADERS, timeout=45)
            r.raise_for_status()
            data = r.json()
            if "errors" in data:
                log.warning("GraphQL errors: %s", data["errors"][:2])
            return data.get("data")
        except (requests.RequestException, ValueError) as e:
            log.warning("UCI GraphQL failed (attempt %d): %s", attempt + 1, e)
            time.sleep(1.5)
    return None


LOCATION_QUERY = """
query getLocation($locationUrlKey: String!, $sortOrder: Commerce_SortOrderEnum) {
  getLocation(campusUrlKey: "campus", locationUrlKey: $locationUrlKey) {
    commerceAttributes {
      children { id uid name position }
    }
  }
  Commerce_mealPeriods(sort_order: $sortOrder) { name id position }
}
"""

RECIPES_QUERY = """
query getLocationRecipes(
  $locationUrlKey: String!
  $date: String!
  $mealPeriod: Int
  $viewType: Commerce_MenuViewType!
) {
  getLocationRecipes(
    campusUrlKey: "campus"
    locationUrlKey: $locationUrlKey
    date: $date
    mealPeriod: $mealPeriod
    viewType: $viewType
  ) {
    locationRecipesMap {
      dateSkuMap {
        date
        stations { id skus { simple } }
      }
    }
    products {
      items {
        sku
        name
        attributes { name value }
      }
    }
  }
}
"""


def _attrs(item: dict) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for a in item.get("attributes") or []:
        out[a.get("name")] = a.get("value")
    return out


def _nutrition(attrs: dict) -> Nutrition:
    size = attrs.get("serving_size") or ""
    unit = attrs.get("serving_unit") or attrs.get("serving_size_unit") or ""
    serving = f"{size} {unit}".strip() if size or unit else ""
    return Nutrition(
        kcal=_num(attrs.get("calories")),
        protein_g=_num(attrs.get("protein")),
        carbs_g=_num(attrs.get("total_carbohydrates")),
        fat_g=_num(attrs.get("total_fat")),
        fiber_g=_num(attrs.get("dietary_fiber")),
        sugar_g=_num(attrs.get("sugars")),
        sodium_mg=_num(attrs.get("sodium")),
        sat_fat_g=_num(attrs.get("saturated_fat")),
        cholesterol_mg=_num(attrs.get("cholesterol")),
        calcium_mg=_num(attrs.get("calcium")),
        iron_mg=_num(attrs.get("iron")),
        vitamin_a_iu=_num(attrs.get("vitamin_a")),
        vitamin_c_mg=_num(attrs.get("vitamin_c")),
        serving=serving,
    )


def _diets_allergens(attrs: dict) -> tuple[list[str], list[str]]:
    diets, allergens = [], []
    prefs = attrs.get("recipe_preferences") or attrs.get("dietary_preferences") or []
    if isinstance(prefs, str):
        prefs = [prefs]
    for p in prefs:
        pl = str(p).lower()
        if "vegan" in pl and "vegan" not in diets:
            diets.append("vegan")
        elif "vegetarian" in pl and "vegetarian" not in diets:
            diets.append("vegetarian")
        if "halal" in pl and "halal" not in diets:
            diets.append("halal")
        if "kosher" in pl and "kosher" not in diets:
            diets.append("kosher")

    statement = str(attrs.get("allergen_statement") or "")
    for needle, key in ALLERGEN_STATEMENT.items():
        if re.search(rf"\b{re.escape(needle)}\b", statement, re.I) and key not in allergens:
            allergens.append(key)
    return diets, allergens


def scrape_hall(session: requests.Session, url_key: str, display: str, day: str) -> Optional[Location]:
    time.sleep(REQUEST_DELAY_S)
    loc_data = gql(session, LOCATION_QUERY, {"locationUrlKey": url_key, "sortOrder": "ASC"})
    if not loc_data or not loc_data.get("getLocation"):
        return None

    stations = {
        int(c["id"]): c["name"]
        for c in (loc_data["getLocation"]["commerceAttributes"].get("children") or [])
    }
    periods_raw = loc_data.get("Commerce_mealPeriods") or []
    # Keep main meal periods only
    periods = []
    for p in periods_raw:
        label = normalize_period(p["name"])
        if label:
            periods.append((int(p["id"]), label, p["name"]))

    location = Location(name=display, kind="dining_hall")
    meals: dict[str, Meal] = {}

    for period_id, period_label, raw_name in periods:
        time.sleep(REQUEST_DELAY_S)
        data = gql(session, RECIPES_QUERY, {
            "locationUrlKey": url_key,
            "date": day,
            "mealPeriod": period_id,
            "viewType": "WEEKLY",
        })
        if not data:
            continue
        block = data.get("getLocationRecipes") or {}
        products = {
            p["sku"]: p for p in ((block.get("products") or {}).get("items") or [])
        }
        date_maps = ((block.get("locationRecipesMap") or {}).get("dateSkuMap") or [])
        day_map = next((d for d in date_maps if d.get("date") == day), None)
        if not day_map:
            continue

        start, end = DEFAULT_HOURS.get(period_label, (None, None))
        if period_label not in meals:
            meals[period_label] = Meal(
                period=period_label, raw_period=raw_name, start=start, end=end,
            )
        meal = meals[period_label]
        seen: set[str] = set()

        for st in day_map.get("stations") or []:
            station_name = stations.get(int(st["id"]), f"Station {st['id']}")
            for sku in (st.get("skus") or {}).get("simple") or []:
                prod = products.get(sku)
                if not prod:
                    continue
                name = (prod.get("name") or "").strip()
                if not name or name.lower() in seen:
                    continue
                seen.add(name.lower())
                attrs = _attrs(prod)
                diets, allergens = _diets_allergens(attrs)
                item = MenuItem(
                    name=name,
                    station=station_name,
                    station_type=classify_station(station_name),
                    dish_key=make_dish_key(SCHOOL, name),
                    nutrition=_nutrition(attrs),
                    allergens=allergens,
                    diets=diets,
                    source_id=sku,
                )
                meal.items.append(apply_tags(item))

    location.meals = [m for m in meals.values() if m.items]
    location.meals.sort(key=lambda m: m.start or "99:99")
    return location if location.meals else None


def scrape(day: str) -> DayMenu:
    result = DayMenu(
        school=SCHOOL, date=day,
        scraped_at=datetime.now(ZoneInfo("UTC")).isoformat(timespec="seconds"),
        timezone=TIMEZONE,
    )
    session = requests.Session()
    for url_key, display in HALLS:
        loc = scrape_hall(session, url_key, display, day)
        if loc:
            n = sum(len(m.items) for m in loc.meals)
            log.info("%s: %d meals, %d items", loc.name, len(loc.meals), n)
            result.locations.append(loc)
        else:
            log.info("%s: no menu for %s", display, day)
    return result
