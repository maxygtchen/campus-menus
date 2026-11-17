"""
UCLA Dining scraper.

Menus live on https://dining.ucla.edu/menus-at-a-glance/ (Jamix WordPress
plugin). The glance page lists every residential hall, meal, station, and
dish for today. Full nutrition is on /menu-item/?recipe=<id>.

The public site currently only publishes *today's* menu, so scrape(day)
returns an empty DayMenu when `day` is not today in America/Los_Angeles.
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime
from html import unescape
from typing import Optional
from zoneinfo import ZoneInfo

import requests

from ..httputil import get
from ..models import DayMenu, Location, Meal, MenuItem, Nutrition, make_dish_key
from ..tags import apply_tags, classify_station

log = logging.getLogger(__name__)

SCHOOL = "ucla"
TIMEZONE = "America/Los_Angeles"
BASE = "https://dining.ucla.edu"
GLANCE = f"{BASE}/menus-at-a-glance/"
RECIPE = f"{BASE}/menu-item/?recipe={{rid}}"
REQUEST_DELAY_S = 0.35

DISPLAY_NAMES = {
    "De Neve Dining": "De Neve",
    "Epicuria at Covel": "Epicuria",
    "Feast at Rieber": "Feast",
}

# Reasonable residential hours when the glance page has none.
DEFAULT_HOURS = {
    "Breakfast": ("07:00", "10:00"),
    "Brunch": ("10:00", "14:00"),
    "Lunch": ("11:00", "14:00"),
    "Dinner": ("17:00", "21:00"),
    "Late Night": ("21:00", "23:00"),
}

ALLERGEN_FROM_ICON = {
    "dairy": "milk", "eggs": "egg", "egg": "egg", "fish": "fish",
    "crustacean-shellfish": "shellfish", "shellfish": "shellfish",
    "tree-nuts": "tree_nuts", "peanut": "peanuts", "peanuts": "peanuts",
    "soy": "soy", "wheat": "wheat", "gluten": "gluten", "sesame": "sesame",
    "alcohol": "alcohol", "pork": "pork",
}
DIET_FROM_ICON = {
    "vegan": "vegan", "vegetarian": "vegetarian", "halal": "halal",
}

_recipe_cache: dict[str, Nutrition] = {}


def _num(v: Optional[str]) -> Optional[float]:
    if v is None:
        return None
    try:
        return round(float(re.sub(r"[^0-9.]+", "", v)), 1)
    except ValueError:
        return None


def normalize_period(raw: str) -> str:
    r = raw.lower()
    for word, label in (("breakfast", "Breakfast"), ("brunch", "Brunch"),
                        ("lunch", "Lunch"), ("dinner", "Dinner"),
                        ("late", "Late Night")):
        if word in r:
            return label
    return "All Day"


def parse_recipe_nutrition(html: str) -> Nutrition:
    serving = ""
    m = re.search(r"Serving Size:</strong>\s*([^<]+)", html, re.I)
    if m:
        serving = unescape(m.group(1)).strip()

    def grab(label: str) -> Optional[float]:
        mm = re.search(
            rf"<span>\s*{re.escape(label)}\s*</span>\s*([0-9.]+)\s*([a-z%]*)",
            html, re.I,
        )
        return _num(mm.group(1)) if mm else None

    kcal = None
    m = re.search(r"class=['\"]single-calories['\"][^>]*>\s*<span>Calories</span>\s*([0-9.]+)", html, re.I)
    if m:
        kcal = _num(m.group(1))
    if kcal is None:
        kcal = grab("Calories")

    return Nutrition(
        kcal=kcal,
        fat_g=grab("Total Fat"),
        sat_fat_g=grab("Saturated Fat"),
        cholesterol_mg=grab("Cholesterol"),
        sodium_mg=grab("Sodium"),
        carbs_g=grab("Total Carbohydrate") or grab("Carbohydrate"),
        fiber_g=grab("Dietary Fiber"),
        sugar_g=grab("Sugars") or grab("Sugar"),
        protein_g=grab("Protein"),
        calcium_mg=None,
        iron_mg=None,
        potassium_mg=None,
        vitamin_c_mg=None,
        vitamin_d_iu=None,
        vitamin_a_iu=None,
        serving=serving,
    )


def _flags_from_icons(chunk: str) -> tuple[list[str], list[str]]:
    allergens, diets = [], []
    for icon in re.findall(r"allergens/([a-z0-9\-]+)\.svg", chunk, re.I):
        key = icon.lower()
        if key in ALLERGEN_FROM_ICON:
            a = ALLERGEN_FROM_ICON[key]
            if a not in allergens:
                allergens.append(a)
        if key in DIET_FROM_ICON:
            d = DIET_FROM_ICON[key]
            if d not in diets:
                diets.append(d)
    # alt/title attributes also encode diets
    for alt in re.findall(r"(?:alt|title)=['\"]([^'\"]+)['\"]", chunk, re.I):
        a = alt.strip().lower()
        if a in DIET_FROM_ICON and DIET_FROM_ICON[a] not in diets:
            diets.append(DIET_FROM_ICON[a])
    return allergens, diets


def parse_glance(html: str) -> list[Location]:
    """Parse the at-a-glance page into locations with meals (nutrition empty)."""
    # Strip scripts/styles so heading scans stay honest.
    cleaned = re.sub(r"<script[\s\S]*?</script>", "", html, flags=re.I)
    cleaned = re.sub(r"<style[\s\S]*?</style>", "", cleaned, flags=re.I)

    # Walk h2 (meal) / h3 (hall) / h4 (station) / recipe links.
    token_re = re.compile(
        r"<h2[^>]*>(.*?)</h2>|<h3[^>]*>(.*?)</h3>|<h4[^>]*>(.*?)</h4>|"
        r"<li>\s*<a href=['\"]/menu-item/\?recipe=(\d+)['\"]>(.*?)</a>([\s\S]*?)</li>",
        re.I,
    )

    locations: dict[str, Location] = {}
    period = None
    hall = None
    station = "Other"

    def loc(name: str) -> Location:
        if name not in locations:
            locations[name] = Location(name=name, kind="dining_hall")
        return locations[name]

    def meal_for(name: str, period_label: str) -> Meal:
        location = loc(name)
        for m in location.meals:
            if m.period == period_label:
                return m
        start, end = DEFAULT_HOURS.get(period_label, (None, None))
        meal = Meal(period=period_label, raw_period=period_label, start=start, end=end)
        location.meals.append(meal)
        return meal

    for m in token_re.finditer(cleaned):
        if m.group(1) is not None:
            raw = unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()
            # e.g. "BREAKFAST MENU FOR TODAY, NOVEMBER 17, 2026"
            if "menu" in raw.lower():
                period = normalize_period(raw)
            continue
        if m.group(2) is not None:
            raw = unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip()
            hall = DISPLAY_NAMES.get(raw, raw)
            station = "Other"
            continue
        if m.group(3) is not None:
            station = unescape(re.sub(r"<[^>]+>", "", m.group(3))).strip() or "Other"
            continue

        if hall is None or period is None:
            continue
        rid, name, rest = m.group(4), m.group(5), m.group(6) or ""
        name = unescape(re.sub(r"<[^>]+>", "", name)).strip()
        if not name:
            continue
        allergens, diets = _flags_from_icons(rest)
        meal = meal_for(hall, period)
        # Dedup by name+station within the meal
        if any(i.name.lower() == name.lower() and i.station.lower() == station.lower()
               for i in meal.items):
            continue
        item = MenuItem(
            name=name,
            station=station,
            station_type=classify_station(station),
            dish_key=make_dish_key(SCHOOL, name),
            nutrition=Nutrition(),
            allergens=allergens,
            diets=diets,
            source_id=rid,
        )
        meal.items.append(apply_tags(item))

    # Sort meals by start time
    for location in locations.values():
        location.meals.sort(key=lambda x: x.start or "99:99")
    return sorted(locations.values(), key=lambda l: l.name)


def enrich_nutrition(session: requests.Session, locations: list[Location]) -> None:
    """Fill nutrition from recipe pages (cached by recipe id)."""
    needed: list[tuple[MenuItem, str]] = []
    for loc in locations:
        for meal in loc.meals:
            for item in meal.items:
                rid = item.source_id
                if not rid:
                    continue
                if rid in _recipe_cache:
                    item.nutrition = _recipe_cache[rid]
                    apply_tags(item)
                else:
                    needed.append((item, rid))

    seen: set[str] = set()
    for item, rid in needed:
        if rid in seen:
            if rid in _recipe_cache:
                item.nutrition = _recipe_cache[rid]
                apply_tags(item)
            continue
        seen.add(rid)
        time.sleep(REQUEST_DELAY_S)
        r = get(session, RECIPE.format(rid=rid))
        if r is None:
            continue
        nut = parse_recipe_nutrition(r.text)
        _recipe_cache[rid] = nut
        item.nutrition = nut
        apply_tags(item)
        # Apply to any other pending items with same rid
        for other, oid in needed:
            if oid == rid:
                other.nutrition = nut
                apply_tags(other)


def scrape(day: str) -> DayMenu:
    today = datetime.now(ZoneInfo(TIMEZONE)).date().isoformat()
    result = DayMenu(
        school=SCHOOL, date=day,
        scraped_at=datetime.now(ZoneInfo("UTC")).isoformat(timespec="seconds"),
        timezone=TIMEZONE,
    )
    if day != today:
        log.info("UCLA glance page only publishes today (%s); skipping %s", today, day)
        return result

    session = requests.Session()
    page = get(session, GLANCE)
    if page is None:
        log.error("UCLA menus-at-a-glance unavailable")
        return result

    locations = parse_glance(page.text)
    enrich_nutrition(session, locations)
    result.locations = locations
    for loc in locations:
        n = sum(len(m.items) for m in loc.meals)
        log.info("%s: %d meals, %d items", loc.name, len(loc.meals), n)
    return result
