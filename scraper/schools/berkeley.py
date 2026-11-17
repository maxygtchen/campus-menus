"""
UC Berkeley Dining scraper.

How Berkeley publishes its menus (checked 2026-11-15):

  1. https://dining.berkeley.edu/menus/ has elements with a `data-location`
     attribute. Each value is base64 for a path like
         /code/wp-content/uploads/menus-exportimport/Crossroads_20261115.xml
  2. Dropping the "/code" prefix gives a public XML file, one per location
     per day, in "EatecExchange" format:
         <EatecExchange>
           <menu location="Crossroads" mealperiodname="Fall - Brunch"
                 mealstarttime="11:00" mealendtime="16:00" servedate="20261115">
             <nutrients>Calories (kcal)|Total Lipid/Fat (g)|...|Protein (g)|...</nutrients>
             <recipes>
               <recipe category="Center Plate" shortName="..." servingSize="5.54"
                       servingSizeUnit="oz" nutrients="585.95|43.87|...">
                 <allergens><allergen id="Milk">Yes</allergen>...</allergens>
                 <dietaryChoices><dietaryChoice id="Vegan Option">No</dietaryChoice>...
  3. So one request per location per day gives every dish with full nutrition.

If Berkeley changes its site, discovery falls back to the known file names.
"""
from __future__ import annotations

import base64
import logging
import re
import time
from datetime import datetime, timezone
from typing import Iterable, Optional
from xml.etree import ElementTree as ET

import requests

from ..always_available import enrich_location
from ..models import DayMenu, Location, Meal, MenuItem, Nutrition, make_dish_key
from ..tags import apply_tags, classify_station

log = logging.getLogger(__name__)

SCHOOL = "berkeley"
TIMEZONE = "America/Los_Angeles"
BASE_URL = "https://dining.berkeley.edu"
MENUS_PAGE = f"{BASE_URL}/menus/"
XML_DIR = "/wp-content/uploads/menus-exportimport"

# File-name stems seen on the live site. Used when discovery fails, and to
# build URLs for dates other than the one the menus page is showing.
KNOWN_STEMS = [
    "Cafe_3", "Clark_Kerr_Campus", "Crossroads", "Foothill",
    "Bear_Market", "Cub_Market", "Den",
]

# Friendlier display names for the app.
DISPLAY_NAMES = {
    "Clark Kerr Campus": "Clark Kerr",
}

MARKET_WORDS = ("market", "den", "cub")

ALLERGENS = {
    "Milk": "milk", "Egg": "egg", "Fish": "fish", "Shellfish": "shellfish",
    "Tree Nuts": "tree_nuts", "Wheat": "wheat", "Peanuts": "peanuts",
    "Soybeans": "soy", "Gluten": "gluten", "Sesame": "sesame",
    "Pork": "pork", "Alcohol": "alcohol",
}
DIETS = {
    "Vegan Option": "vegan", "Vegetarian Option": "vegetarian",
    "Halal": "halal", "Kosher": "kosher",
}

# Nutrient columns we keep, matched by the start of the column name.
NUTRIENT_COLUMNS = {
    "kcal": "Calories",
    "fat_g": "Total Lipid",
    "carbs_g": "Carbohydrate",
    "fiber_g": "Total Dietary Fiber",
    "sugar_g": "Sugar",
    "protein_g": "Protein",
    "sodium_mg": "Sodium",
    "carbon_kg": "Carbon Footprint",
    # Extra detail for the meal calculator
    "sat_fat_g": "Saturated",
    "cholesterol_mg": "Cholesterol",
    "calcium_mg": "Calcium",
    "iron_mg": "Iron",
    "potassium_mg": "Potassium",
    "vitamin_c_mg": "Vitamin C",
    "vitamin_d_iu": "Vitamin D",
    "vitamin_a_iu": "Vitamin A (iu)",
}
EXTRA_NUTRIENTS = ("sat_fat_g", "cholesterol_mg", "calcium_mg", "iron_mg",
                   "potassium_mg", "vitamin_c_mg", "vitamin_d_iu", "vitamin_a_iu")

MAX_NAME_LEN = 80        # longer "names" are location blurbs, not dishes
MAX_SANE_KCAL = 2500     # bulk-serving data entry errors

HEADERS = {
    # Identify ourselves honestly. Put a real contact here before deploying.
    "User-Agent": "campus-menus/0.1 (student project; contact: YOUR_EMAIL)",
}
REQUEST_DELAY_S = 1.0    # be polite: one request per second


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------

def _get(session: requests.Session, url: str) -> Optional[requests.Response]:
    for attempt in range(2):
        try:
            r = session.get(url, headers=HEADERS, timeout=20)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            log.warning("GET %s failed (attempt %d): %s", url, attempt + 1, e)
            time.sleep(2)
    return None


def discover_stems(html: str) -> list[str]:
    """Pull location file-name stems out of the menus page HTML."""
    stems: list[str] = []
    for b64 in set(re.findall(r'data-location=["\']([A-Za-z0-9+/=]+)["\']', html)):
        try:
            path = base64.b64decode(b64 + "=" * (-len(b64) % 4)).decode("utf-8")
        except Exception:
            continue
        m = re.search(r"/([A-Za-z0-9_\-]+)_\d{8}\.xml$", path)
        if m and m.group(1) not in stems:
            stems.append(m.group(1))
    return stems


def xml_urls_for(day: str, stems: Iterable[str]) -> list[str]:
    ymd = day.replace("-", "")
    return [f"{BASE_URL}{XML_DIR}/{stem}_{ymd}.xml" for stem in stems]


# --------------------------------------------------------------------------
# Parsing (pure functions: easy to test without the network)
# --------------------------------------------------------------------------

def normalize_period(raw: str) -> str:
    r = raw.lower()
    for word, label in (("breakfast", "Breakfast"), ("brunch", "Brunch"),
                        ("lunch", "Lunch"), ("dinner", "Dinner"),
                        ("late", "Late Night")):
        if word in r:
            return label
    return "All Day"


def _num(v: str) -> Optional[float]:
    try:
        return round(float(v), 1) if v.strip() != "" else None
    except ValueError:
        return None


def _hhmm(v: Optional[str]) -> Optional[str]:
    return v if v and re.fullmatch(r"\d{1,2}:\d{2}", v) else None


def _yes_flags(parent: Optional[ET.Element], tag: str, mapping: dict) -> list[str]:
    if parent is None:
        return []
    out = []
    for el in parent.findall(tag):
        if (el.text or "").strip().lower() == "yes" and el.get("id") in mapping:
            key = mapping[el.get("id")]
            if key not in out:
                out.append(key)
    return out


def parse_recipe(rec: ET.Element, columns: list[str]) -> Optional[MenuItem]:
    name = (rec.get("shortName") or rec.get("description") or "").strip()
    if not name or len(name) > MAX_NAME_LEN:
        return None

    values = (rec.get("nutrients") or "").split("|")
    found: dict[str, Optional[float]] = {}
    for key, prefix in NUTRIENT_COLUMNS.items():
        idx = next((i for i, c in enumerate(columns) if c.startswith(prefix)), None)
        found[key] = _num(values[idx]) if idx is not None and idx < len(values) else None

    if found["kcal"] is not None and found["kcal"] > MAX_SANE_KCAL:
        log.debug("Skipping %r: %s kcal looks like a bulk serving", name, found["kcal"])
        return None

    size, unit = rec.get("servingSize", ""), rec.get("servingSizeUnit", "")
    station = (rec.get("category") or "Other").strip()

    item = MenuItem(
        name=name,
        station=station,
        station_type=classify_station(station),
        dish_key=make_dish_key(SCHOOL, name),
        nutrition=Nutrition(
            kcal=found["kcal"], protein_g=found["protein_g"],
            carbs_g=found["carbs_g"], fat_g=found["fat_g"],
            fiber_g=found["fiber_g"], sugar_g=found["sugar_g"],
            sodium_mg=found["sodium_mg"],
            serving=f"{size} {unit}".strip() if size else "",
            **{key: found[key] for key in EXTRA_NUTRIENTS},
        ),
        allergens=_yes_flags(rec.find("allergens"), "allergen", ALLERGENS),
        diets=_yes_flags(rec.find("dietaryChoices"), "dietaryChoice", DIETS),
        carbon_kg=found["carbon_kg"],
        source_id=rec.get("id", ""),
    )
    return apply_tags(item)


def parse_location_xml(xml_text: str) -> Optional[Location]:
    """Parse one location's XML file into a Location with its meals."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        log.error("Bad XML: %s", e)
        return None

    menus = root.findall("menu")
    if not menus:
        return None

    raw_name = (menus[0].get("location") or "Unknown").strip()
    name = DISPLAY_NAMES.get(raw_name, raw_name)
    kind = "market" if any(w in name.lower() for w in MARKET_WORDS) else "dining_hall"
    location = Location(name=name, kind=kind)

    for menu in menus:
        cols_el = menu.find("nutrients")
        columns = [c.strip() for c in (cols_el.text or "").split("|")] if cols_el is not None else []
        raw_period = (menu.get("mealperiodname") or "").strip()
        meal = Meal(
            period=normalize_period(raw_period),
            raw_period=raw_period,
            start=_hhmm(menu.get("mealstarttime")),
            end=_hhmm(menu.get("mealendtime")),
        )
        seen: set[tuple[str, str]] = set()
        for rec in menu.findall("recipes/recipe"):
            item = parse_recipe(rec, columns)
            if item is None:
                continue
            key = (item.name.lower(), item.station.lower())
            if key in seen:            # the source sometimes lists a dish twice
                continue
            seen.add(key)
            meal.items.append(item)
        if meal.items:
            location.meals.append(meal)

    location.meals.sort(key=lambda m: m.start or "99:99")
    return location if location.meals else None


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def scrape(day: str) -> DayMenu:
    """Scrape every Berkeley location for `day` (YYYY-MM-DD)."""
    session = requests.Session()
    stems = list(KNOWN_STEMS)

    page = _get(session, MENUS_PAGE)
    if page is not None:
        found = discover_stems(page.text)
        log.info("Discovered %d locations on the menus page", len(found))
        stems = found + [s for s in KNOWN_STEMS if s not in found]
    else:
        log.warning("Menus page unavailable; using known location list")

    result = DayMenu(
        school=SCHOOL,
        date=day,
        scraped_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        timezone=TIMEZONE,
    )
    for url in xml_urls_for(day, stems):
        time.sleep(REQUEST_DELAY_S)
        r = _get(session, url)
        if r is None:
            log.info("No menu at %s", url.rsplit("/", 1)[-1])
            continue
        loc = parse_location_xml(r.text)
        if loc:
            enrich_location(loc)
            n = sum(len(m.items) for m in loc.meals)
            log.info("%s: %d meals, %d items", loc.name, len(loc.meals), n)
            result.locations.append(loc)

    # Dining halls first, then markets.
    result.locations.sort(key=lambda l: (l.kind != "dining_hall", l.name))
    return result
