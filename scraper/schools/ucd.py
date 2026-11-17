"""
UC Davis Dining Commons scraper.

Weekly menus with nutrition are embedded on each commons page, e.g.
  https://housing.ucdavis.edu/dining/dining-commons/segundo/

Day tabs (#sunday … #saturday) contain Breakfast / Lunch / Dinner sections
with zone stations and accordion dish panels (calories, macros, allergens).
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime
from html import unescape
from typing import Optional
from zoneinfo import ZoneInfo

import requests
import urllib3

from ..httputil import get
from ..models import DayMenu, Location, Meal, MenuItem, Nutrition, make_dish_key
from ..tags import apply_tags, classify_station

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

log = logging.getLogger(__name__)

SCHOOL = "ucd"
TIMEZONE = "America/Los_Angeles"
BASE = "https://housing.ucdavis.edu/dining/dining-commons"

HALLS = [
    ("segundo", "Segundo"),
    ("tercero", "Tercero"),
    ("cuarto", "Cuarto"),
]

DEFAULT_HOURS = {
    "Breakfast": ("07:00", "10:00"),
    "Brunch": ("10:00", "14:00"),
    "Lunch": ("11:00", "14:00"),
    "Dinner": ("16:30", "20:00"),
}

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _num(v: Optional[str]) -> Optional[float]:
    if v is None:
        return None
    try:
        return round(float(re.sub(r"[^0-9.]+", "", v)), 1)
    except ValueError:
        return None


def weekday_name(day: str) -> str:
    return date.fromisoformat(day).strftime("%A").lower()


def parse_panel_nutrition(body: str) -> tuple[Nutrition, list[str], list[str]]:
    def grab(label: str) -> Optional[float]:
        m = re.search(
            rf"<strong>\s*{re.escape(label)}\s*</strong>\s*:?\s*([0-9.]+)",
            body, re.I,
        )
        return _num(m.group(1)) if m else None

    serving = ""
    m = re.search(r"<strong>\s*Serving Size\s*</strong>\s*:?\s*([^<]+)", body, re.I)
    if m:
        serving = unescape(m.group(1)).strip()

    nut = Nutrition(
        kcal=grab("Calories"),
        fat_g=grab("Fat (g)") or grab("Fat"),
        carbs_g=grab("Carbohydrates (g)") or grab("Carbohydrates"),
        sugar_g=grab("Sugar") or grab("Sugars"),
        protein_g=grab("Protein (g)") or grab("Protein"),
        sodium_mg=grab("Sodium (mg)") or grab("Sodium"),
        fiber_g=grab("Fiber (g)") or grab("Fiber"),
        serving=serving,
    )

    diets: list[str] = []
    allergens: list[str] = []
    for alt in re.findall(r'alt=["\']([^"\']+)["\']', body, re.I):
        a = alt.strip().lower()
        if a == "vegan" and "vegan" not in diets:
            diets.append("vegan")
        elif a == "vegetarian" and "vegetarian" not in diets:
            diets.append("vegetarian")
        elif a == "halal" and "halal" not in diets:
            diets.append("halal")

    m = re.search(r"<strong>\s*Contains\s*</strong>\s*:?\s*([^<]+)", body, re.I)
    if m:
        raw = m.group(1).lower()
        mapping = {
            "dairy": "milk", "egg": "egg", "peanut": "peanuts", "tree nut": "tree_nuts",
            "soy": "soy", "wheat": "wheat", "gluten": "gluten", "fish": "fish",
            "shellfish": "shellfish", "sesame": "sesame", "alcohol": "alcohol",
        }
        for needle, key in mapping.items():
            if needle in raw and key not in allergens:
                allergens.append(key)

    # Panel class filters also encode diets
    return nut, allergens, diets


def parse_day_pane(pane: str) -> list[Meal]:
    meals: dict[str, Meal] = {}
    period = None
    station = "Other"

    # Split by h2 meal headers and h3 zone stations, plus dish panels.
    token_re = re.compile(
        r"<h2[^>]*>(.*?)</h2>|<h3[^>]*>(.*?)</h3>|"
        r"<a[^>]*class=\"[^\"]*nutrition-panel[^\"]*\"[^>]*>(.*?)</a>"
        r"([\s\S]*?)</div>\s*</div>\s*</div>",
        re.I,
    )

    for m in token_re.finditer(pane):
        if m.group(1) is not None:
            raw = unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()
            low = raw.lower()
            if low in ("breakfast", "brunch", "lunch", "dinner", "late night"):
                period = raw.title() if raw.lower() != "late night" else "Late Night"
                if period == "Late Night":
                    pass
                elif low == "breakfast":
                    period = "Breakfast"
                elif low == "brunch":
                    period = "Brunch"
                elif low == "lunch":
                    period = "Lunch"
                elif low == "dinner":
                    period = "Dinner"
            continue
        if m.group(2) is not None:
            station = unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip() or "Other"
            continue
        if period is None:
            continue
        name = unescape(re.sub(r"<[^>]+>", "", m.group(3))).strip()
        body = m.group(4) or ""
        if not name or name.lower().startswith("currently there are no"):
            continue
        nut, allergens, diets = parse_panel_nutrition(body)
        # Diets from surrounding panel class
        panel_start = pane.rfind("panel panel-default", 0, m.start())
        if panel_start >= 0:
            cls = pane[panel_start:panel_start + 200]
            if "isVegan" in cls and "vegan" not in diets:
                diets.append("vegan")
            if "isVegetarian" in cls and "vegetarian" not in diets and "vegan" not in diets:
                diets.append("vegetarian")
            if "isHalal" in cls and "halal" not in diets:
                diets.append("halal")

        if period not in meals:
            start, end = DEFAULT_HOURS.get(period, (None, None))
            meals[period] = Meal(period=period, raw_period=period, start=start, end=end)
        meal = meals[period]
        if any(i.name.lower() == name.lower() for i in meal.items):
            continue
        item = MenuItem(
            name=name,
            station=station,
            station_type=classify_station(station),
            dish_key=make_dish_key(SCHOOL, name),
            nutrition=nut,
            allergens=allergens,
            diets=diets,
        )
        meal.items.append(apply_tags(item))

    return sorted(meals.values(), key=lambda x: x.start or "99:99")


def extract_day_pane(html: str, day: str) -> Optional[str]:
    wd = weekday_name(day)
    # Find id="tuesday" (etc.) and cut until the next weekday pane id.
    start = re.search(rf'id="{wd}"', html, re.I)
    if not start:
        return None
    rest = html[start.end():]
    next_ids = [d for d in WEEKDAYS if d != wd]
    ends = [m.start() for d in next_ids for m in [re.search(rf'id="{d}"', rest, re.I)] if m]
    end = min(ends) if ends else len(rest)
    return rest[:end]


def scrape(day: str) -> DayMenu:
    result = DayMenu(
        school=SCHOOL, date=day,
        scraped_at=datetime.now(ZoneInfo("UTC")).isoformat(timespec="seconds"),
        timezone=TIMEZONE,
    )
    session = requests.Session()

    for slug, display in HALLS:
        url = f"{BASE}/{slug}/"
        page = get(session, url, verify=False, timeout=60)
        if page is None:
            log.warning("UCD page missing: %s", url)
            continue
        pane = extract_day_pane(page.text, day)
        if not pane:
            log.info("%s: no day pane for %s", display, day)
            continue
        meals = parse_day_pane(pane)
        if not meals:
            log.info("%s: no meals for %s", display, day)
            continue
        location = Location(name=display, kind="dining_hall", meals=meals)
        n = sum(len(m.items) for m in location.meals)
        log.info("%s: %d meals, %d items", display, len(location.meals), n)
        result.locations.append(location)

    return result
