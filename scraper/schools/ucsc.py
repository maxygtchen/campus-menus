"""
UC Santa Cruz Dining scraper (FoodPro / Aurora).

Index: https://nutrition.sa.ucsc.edu/
Per hall: shortmenu.aspx (names + stations by meal). Optional nutrition
from label.aspx linked off longmenu.aspx.
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime
from html import unescape
from typing import Optional
from urllib.parse import quote, unquote, urljoin
from zoneinfo import ZoneInfo

import requests
import urllib3

from ..httputil import get
from ..models import DayMenu, Location, Meal, MenuItem, Nutrition, make_dish_key
from ..tags import apply_tags, classify_station

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

log = logging.getLogger(__name__)

SCHOOL = "ucsc"
TIMEZONE = "America/Los_Angeles"
BASE = "https://nutrition.sa.ucsc.edu/"
REQUEST_DELAY_S = 0.3
ENRICH_LABELS = True
MAX_LABELS = 120

KNOWN_HALLS = [
    ("40", "John R. Lewis & College Nine"),
    ("05", "Cowell & Stevenson"),
    ("20", "Crown & Merrill"),
    ("25", "Porter & Kresge"),
    ("30", "Rachel Carson & Oakes"),
]

DEFAULT_HOURS = {
    "Breakfast": ("07:00", "11:00"),
    "Lunch": ("11:00", "14:00"),
    "Dinner": ("17:00", "21:00"),
    "Late Night": ("21:00", "23:00"),
}

_nutrition_cache: dict[str, Nutrition] = {}


def _num(v: Optional[str]) -> Optional[float]:
    if v is None:
        return None
    try:
        return round(float(re.sub(r"[^0-9.]+", "", v)), 1)
    except ValueError:
        return None


def _mdy(day: str) -> str:
    y, m, d = day.split("-")
    return f"{int(m)}/{int(d)}/{y}"


def _clean_station(raw: str) -> str:
    s = unescape(raw).replace("\xa0", " ").strip()
    s = s.strip("- ").strip()
    return s or "Other"


def discover_halls(session: requests.Session) -> list[tuple[str, str]]:
    page = get(session, BASE, verify=False)
    if page is None:
        return list(KNOWN_HALLS)
    found: list[tuple[str, str]] = []
    for num, name in re.findall(
        r"shortmenu\.aspx\?[^\"']*locationNum=(\d+)[^\"']*locationName=([^&\"']+)",
        page.text, re.I,
    ):
        display = unquote(name.replace("+", " "))
        if "Dining Hall" in display or num in {h[0] for h in KNOWN_HALLS}:
            display = display.replace(" Dining Hall", "").strip()
            if not any(n == num for n, _ in found):
                found.append((num, display))
    # Prefer known order / names
    by_num = {n: d for n, d in found}
    ordered = []
    for num, name in KNOWN_HALLS:
        ordered.append((num, by_num.get(num, name)))
    return ordered


def parse_label(html: str) -> Nutrition:
    def grab(label: str) -> Optional[float]:
        # FoodPro labels interleave tags: Protein&nbsp;</b></font><font>2.3g
        m = re.search(
            rf"{re.escape(label)}(?:&nbsp;|\s|:)*(?:<[^>]+>\s*)*([0-9]+\.?[0-9]*)",
            html, re.I,
        )
        return _num(m.group(1)) if m else None

    return Nutrition(
        kcal=grab("Calories"),
        fat_g=grab("Total Fat"),
        sat_fat_g=grab("Sat. Fat") or grab("Saturated Fat"),
        cholesterol_mg=grab("Cholesterol"),
        sodium_mg=grab("Sodium"),
        carbs_g=grab("Total Carbohydrate") or grab("Tot. Carb") or grab("Total Carb"),
        fiber_g=grab("Dietary Fiber") or grab("Fiber"),
        sugar_g=grab("Sugars") or grab("Sugar"),
        protein_g=grab("Protein"),
    )


def parse_shortmenu(html: str) -> list[Meal]:
    parts = re.split(r"class=['\"]shortmenumeals['\"]", html, flags=re.I)
    meals: list[Meal] = []
    for part in parts[1:]:
        m = re.match(r"[^>]*>\s*([^<]+)", part)
        if not m:
            continue
        period = unescape(m.group(1)).strip()
        if period not in DEFAULT_HOURS:
            continue
        start, end = DEFAULT_HOURS[period]
        meal = Meal(period=period, raw_period=period, start=start, end=end)
        station = "Other"
        # Walk cats and recipes in order within this meal chunk
        # (until we'd hit another meal — already split)
        for kind, text in re.findall(
            r"class=['\"]shortmenucats['\"][^>]*>([\s\S]*?)</|"
            r"class=['\"]shortmenurecipes['\"][^>]*>([\s\S]*?)</div>",
            part, re.I,
        ):
            if kind:
                station = _clean_station(re.sub(r"<[^>]+>", "", kind))
                continue
            name = unescape(re.sub(r"<[^>]+>", "", text or "")).replace("\xa0", " ").strip()
            if not name:
                continue
            if any(i.name.lower() == name.lower() for i in meal.items):
                continue
            item = MenuItem(
                name=name,
                station=station,
                station_type=classify_station(station),
                dish_key=make_dish_key(SCHOOL, name),
                nutrition=Nutrition(),
            )
            meal.items.append(apply_tags(item))
        if meal.items:
            meals.append(meal)
    return meals


def longmenu_labels(html: str) -> dict[str, str]:
    """Map dish name -> label.aspx path."""
    out: dict[str, str] = {}
    for href, name in re.findall(
        r"href=['\"](label\.aspx\?[^'\"]+)['\"][^>]*>(.*?)</a>",
        html, re.I | re.S,
    ):
        name = unescape(re.sub(r"<[^>]+>", "", name)).replace("\xa0", " ").strip()
        if name and name not in out:
            out[name] = href.replace("&amp;", "&")
    return out


def enrich_meal(session: requests.Session, meal: Meal, labels: dict[str, str]) -> None:
    global_count = len(_nutrition_cache)
    for item in meal.items:
        if global_count >= MAX_LABELS:
            return
        href = labels.get(item.name)
        if not href:
            continue
        if href in _nutrition_cache:
            item.nutrition = _nutrition_cache[href]
            apply_tags(item)
            continue
        time.sleep(REQUEST_DELAY_S)
        page = get(session, urljoin(BASE, href), verify=False)
        global_count += 1
        if page is None or "Runtime Error" in page.text:
            continue
        nut = parse_label(page.text)
        _nutrition_cache[href] = nut
        item.nutrition = nut
        apply_tags(item)


def scrape(day: str) -> DayMenu:
    result = DayMenu(
        school=SCHOOL, date=day,
        scraped_at=datetime.now(ZoneInfo("UTC")).isoformat(timespec="seconds"),
        timezone=TIMEZONE,
    )
    session = requests.Session()
    get(session, BASE, verify=False)
    halls = discover_halls(session)
    dtdate = quote(_mdy(day), safe="")

    for loc_num, display in halls:
        time.sleep(REQUEST_DELAY_S)
        short_url = (
            f"{BASE}shortmenu.aspx?sName=UC+Santa+Cruz+Dining"
            f"&locationNum={loc_num}&locationName={quote(display)}"
            f"&naFlag=1&dtdate={dtdate}"
        )
        page = get(session, short_url, verify=False)
        if page is None or "Runtime Error" in page.text:
            log.info("%s: shortmenu unavailable", display)
            continue
        meals = parse_shortmenu(page.text)
        if not meals:
            continue

        if ENRICH_LABELS:
            for meal in meals:
                time.sleep(REQUEST_DELAY_S)
                long_url = (
                    f"{BASE}longmenu.aspx?sName=UC+Santa+Cruz+Dining"
                    f"&locationNum={loc_num}&locationName={quote(display)}"
                    f"&naFlag=1&WeeksMenus=This+Week%27s+Menus"
                    f"&dtdate={dtdate}&mealName={quote(meal.period)}"
                )
                long_page = get(session, long_url, verify=False)
                if long_page and "Runtime Error" not in long_page.text:
                    enrich_meal(session, meal, longmenu_labels(long_page.text))

        location = Location(name=display, kind="dining_hall", meals=meals)
        n = sum(len(m.items) for m in location.meals)
        log.info("%s: %d meals, %d items", display, len(location.meals), n)
        result.locations.append(location)

    return result
