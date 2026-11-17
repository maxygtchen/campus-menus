"""
UC San Diego HDH dining scraper.

Menus: https://hdh-web.ucsd.edu/dining/apps/diningservices/Restaurants/Venue_V3
Full nutrition: Nutrition/Nutritionfacts2?id=&recId=

Listing pages already include calories and allergen/diet icons. We optionally
enrich with full Nutritionfacts2 for protein/carbs/etc., caching by recId.
"""
from __future__ import annotations

import logging
import re
import time
from datetime import date, datetime, timedelta
from html import unescape
from typing import Optional
from zoneinfo import ZoneInfo

import requests

from ..httputil import get
from ..models import DayMenu, Location, Meal, MenuItem, Nutrition, make_dish_key
from ..tags import apply_tags, classify_station

log = logging.getLogger(__name__)

SCHOOL = "ucsd"
TIMEZONE = "America/Los_Angeles"
BASE = "https://hdh-web.ucsd.edu/dining/apps/diningservices"
INDEX = f"{BASE}/Restaurants"
VENUE = f"{BASE}/Restaurants/Venue_V3"
NUTRITION = f"{BASE}/Nutrition/Nutritionfacts2"
REQUEST_DELAY_S = 0.2
# Listing pages already include calories + diet/allergen icons. Full
# Nutritionfacts2 enrichment is optional (slow — many unique recipes).
ENRICH_NUTRITION = False
MAX_ENRICH = 150  # used only when ENRICH_NUTRITION is True

# Residential / major dining venues (skip faculty club etc. if desired).
# locId -> (locDetID, display name override or None to use <title>/<h1>)
KNOWN_VENUES = {
    "2": ("37", "64 Degrees"),
    "13": ("27", "Bistro"),
    "10": ("22", "Canyon Vista"),
    "12": ("14", "Club Med"),
    "14": ("13", "Foodworx"),
    "8": ("8", "OceanView"),
    "3": ("6", "Pines"),
    "4": ("30", "Sixth College"),
    "9": ("52", "Ventanas"),
}

DEFAULT_HOURS = {
    "Breakfast": ("07:00", "11:00"),
    "Brunch": ("10:00", "14:00"),
    "Lunch": ("11:00", "14:00"),
    "Dinner": ("17:00", "21:00"),
    "Late Night": ("21:00", "23:00"),
}

ICON_ALLERGEN = {
    "containseggs": "egg", "eggs": "egg",
    "containsmilk": "milk", "milk": "milk", "dairy": "milk",
    "containspeanuts": "peanuts", "peanuts": "peanuts",
    "containstreenuts": "tree_nuts", "treenuts": "tree_nuts",
    "containssoy": "soy", "soy": "soy",
    "containsfish": "fish", "fish": "fish",
    "containsshellfish": "shellfish", "shellfish": "shellfish",
    "containsgluten": "gluten", "gluten": "gluten", "wheat": "wheat",
    "containssesame": "sesame", "sesame": "sesame",
}
ICON_DIET = {
    "vegan": "vegan", "vegetarian": "vegetarian", "halal": "halal",
}

_nutrition_cache: dict[str, Nutrition] = {}


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


def day_offset(day: str) -> Optional[int]:
    """HDH uses dayNum=0 for today, 1 for tomorrow, etc."""
    today = datetime.now(ZoneInfo(TIMEZONE)).date()
    target = date.fromisoformat(day)
    delta = (target - today).days
    if delta < 0 or delta > 6:
        return None
    return delta


def discover_venues(html: str) -> dict[str, tuple[str, str]]:
    """locId -> (locDetID, name) from the restaurants index."""
    found = dict(KNOWN_VENUES)
    for loc_id, det in re.findall(r"Venue_V3\?locId=(\d+)&locDetID=(\d+)&dayNum=0", html):
        if loc_id not in found:
            found[loc_id] = (det, None)  # type: ignore[assignment]
    return found


def _icons_from(chunk: str) -> tuple[list[str], list[str]]:
    allergens, diets = [], []
    for title in re.findall(r"title=['\"]([^'\"]+)['\"]", chunk, re.I):
        t = re.sub(r"[^a-z]", "", title.lower())
        # strip legend prefixes
        t = t.replace("legend", "").replace("icon", "").replace("contains", "contains")
        for key, val in ICON_DIET.items():
            if key in t and val not in diets:
                diets.append(val)
        for key, val in ICON_ALLERGEN.items():
            if key in t and val not in allergens:
                allergens.append(val)
    for src in re.findall(r"allergenicons/([^/\"']+)", chunk, re.I):
        stem = re.sub(r"[^a-z]", "", src.lower().split("_")[0])
        for key, val in ICON_DIET.items():
            if key in stem and val not in diets:
                diets.append(val)
        for key, val in ICON_ALLERGEN.items():
            if key.replace("contains", "") in stem or key in stem:
                if val not in allergens and key.startswith("contains") or key in stem:
                    if val not in allergens:
                        allergens.append(val)
    return allergens, diets


def parse_nutrition_page(html: str) -> Nutrition:
    def grab(label: str) -> Optional[float]:
        # e.g. <th>Calories</th><td>313</td>  or  Total Fat&nbsp;26.1 g
        m = re.search(
            rf"(?:<th[^>]*>\s*{re.escape(label)}\s*</th>\s*<td[^>]*>\s*([0-9.]+))"
            rf"|(?:{re.escape(label)}(?:&nbsp;|\s)+([0-9.]+)\s*g)",
            html, re.I,
        )
        if not m:
            return None
        return _num(m.group(1) or m.group(2))

    serving = ""
    m = re.search(r"Serving Size\s*([^<]+)", html, re.I)
    if m:
        serving = unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()

    return Nutrition(
        kcal=grab("Calories"),
        fat_g=grab("Total Fat"),
        sat_fat_g=grab("Saturated Fat") or grab(r"Sat. Fat"),
        cholesterol_mg=grab("Cholesterol"),
        sodium_mg=grab("Sodium"),
        carbs_g=grab("Total Carbohydrate") or grab("Total Carb") or grab("Carbohydrate"),
        fiber_g=grab("Dietary Fiber"),
        sugar_g=grab("Sugars") or grab("Sugar"),
        protein_g=grab("Protein"),
        serving=serving,
    )


def parse_venue(html: str, fallback_name: Optional[str]) -> Optional[Location]:
    h1 = re.search(r"<h1[^>]*>([^<]+)", html)
    title = re.search(r"<title>([^|<]+)", html)
    name = (h1.group(1) if h1 else title.group(1) if title else fallback_name or "Unknown")
    name = unescape(name).replace("Food Menu", "").strip()
    if fallback_name:
        name = fallback_name

    location = Location(name=name, kind="dining_hall")
    period = None
    station = "Other"
    meals: dict[str, Meal] = {}

    token_re = re.compile(
        r"<h2[^>]*>(.*?)</h2>|<h3[^>]*>(.*?)</h3>|<h4[^>]*>(.*?)</h4>|"
        r"<a[^>]*>([^<]{2,100})</a>\s*</div>\s*<div class=\"proI\">\s*<span>([^<]*)</span>"
        r"([\s\S]{0,2000}?)Nutritionfacts2\?id=(\d+)&(?:amp;)?recId=(\d+)",
        re.I,
    )

    for m in token_re.finditer(html):
        if m.group(1) is not None:
            raw = unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()
            if raw.lower().endswith("menu") or any(
                w in raw.lower() for w in ("breakfast", "lunch", "dinner", "brunch", "late")
            ):
                period = normalize_period(raw)
            continue
        if m.group(2) is not None:
            station = unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip() or "Other"
            if station.lower() == "closed":
                station = "Other"
            continue
        if m.group(3) is not None:
            # subcategory — keep as part of station context if useful
            continue

        if not period:
            continue
        dish = unescape(m.group(4)).strip()
        if not dish or dish.lower() in ("nutrition/allergen info", "menus"):
            continue
        chunk = m.group(6) or ""
        cals_m = re.search(r'class="cals">(\d+)\s*Cals', chunk)
        kcal = _num(cals_m.group(1)) if cals_m else None
        allergens, diets = _icons_from(chunk)
        nid, rid = m.group(7), m.group(8)

        if period not in meals:
            start, end = DEFAULT_HOURS.get(period, (None, None))
            meals[period] = Meal(period=period, raw_period=period, start=start, end=end)
        meal = meals[period]
        if any(i.name.lower() == dish.lower() and i.station.lower() == station.lower()
               for i in meal.items):
            continue
        item = MenuItem(
            name=dish,
            station=station,
            station_type=classify_station(station),
            dish_key=make_dish_key(SCHOOL, dish),
            nutrition=Nutrition(kcal=kcal),
            allergens=allergens,
            diets=diets,
            source_id=f"{nid}:{rid}",
        )
        meal.items.append(apply_tags(item))

    location.meals = sorted(meals.values(), key=lambda x: x.start or "99:99")
    return location if location.meals else None


def enrich(session: requests.Session, locations: list[Location]) -> None:
    if not ENRICH_NUTRITION:
        return
    count = 0
    for loc in locations:
        for meal in loc.meals:
            for item in meal.items:
                if count >= MAX_ENRICH:
                    return
                if not item.source_id or ":" not in item.source_id:
                    continue
                nid, rid = item.source_id.split(":", 1)
                if rid in _nutrition_cache:
                    base = item.nutrition
                    full = _nutrition_cache[rid]
                    item.nutrition = Nutrition(
                        kcal=full.kcal or base.kcal,
                        protein_g=full.protein_g, carbs_g=full.carbs_g, fat_g=full.fat_g,
                        fiber_g=full.fiber_g, sugar_g=full.sugar_g, sodium_mg=full.sodium_mg,
                        sat_fat_g=full.sat_fat_g, cholesterol_mg=full.cholesterol_mg,
                        serving=full.serving or base.serving,
                    )
                    apply_tags(item)
                    continue
                time.sleep(REQUEST_DELAY_S)
                r = get(session, f"{NUTRITION}?id={nid}&recId={rid}")
                count += 1
                if r is None:
                    continue
                nut = parse_nutrition_page(r.text)
                if nut.kcal is None and item.nutrition.kcal is not None:
                    nut.kcal = item.nutrition.kcal
                _nutrition_cache[rid] = nut
                item.nutrition = nut
                apply_tags(item)


def scrape(day: str) -> DayMenu:
    result = DayMenu(
        school=SCHOOL, date=day,
        scraped_at=datetime.now(ZoneInfo("UTC")).isoformat(timespec="seconds"),
        timezone=TIMEZONE,
    )
    offset = day_offset(day)
    if offset is None:
        log.info("UCSD dayNum only covers today..+6; skipping %s", day)
        return result

    session = requests.Session()
    index = get(session, INDEX, timeout=90)
    venues = discover_venues(index.text) if index else dict(KNOWN_VENUES)

    for loc_id, (det_id, name) in sorted(venues.items(), key=lambda kv: kv[1][1] or kv[0]):
        if loc_id == "7":  # Cecil's at Faculty Club — skip
            continue
        url = f"{VENUE}?locId={loc_id}&locDetID={det_id}&dayNum={offset}"
        time.sleep(REQUEST_DELAY_S)
        r = get(session, url, timeout=90)
        if r is None or not r.content:
            log.info("No menu for locId=%s", loc_id)
            continue
        loc = parse_venue(r.text, name)
        if loc:
            n = sum(len(m.items) for m in loc.meals)
            log.info("%s: %d meals, %d items", loc.name, len(loc.meals), n)
            result.locations.append(loc)

    enrich(session, result.locations)
    result.locations.sort(key=lambda l: l.name)
    return result
