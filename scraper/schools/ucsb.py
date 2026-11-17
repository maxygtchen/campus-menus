"""
UCSB Campus Dining scraper.

Daily menus (server-rendered HTML):
  https://apps.dining.ucsb.edu/menu/day?dc=<hall>&m=<meal>&d=YYYY-MM-DD

Dish names include (v) / (vgn) diet markers. Full nutrition is not on the
public day menu.
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime
from html import unescape
from zoneinfo import ZoneInfo

import requests

from ..httputil import get
from ..models import DayMenu, Location, Meal, MenuItem, Nutrition, make_dish_key
from ..tags import apply_tags, classify_station

log = logging.getLogger(__name__)

SCHOOL = "ucsb"
TIMEZONE = "America/Los_Angeles"
MENU_DAY = "https://apps.dining.ucsb.edu/menu/day"
REQUEST_DELAY_S = 0.4

HALLS = [
    ("carrillo", "Carrillo"),
    ("de-la-guerra", "De La Guerra"),
    ("ortega", "Ortega"),
    ("portola", "Portola"),
]

# Meal query values accepted by the day menu.
MEALS = [
    ("breakfast", "Breakfast", "07:15", "10:00"),
    ("brunch", "Brunch", "10:30", "14:00"),
    ("lunch", "Lunch", "11:00", "14:30"),
    ("dinner", "Dinner", "17:00", "20:00"),
    ("late-night", "Late Night", "20:00", "23:00"),
]


def _diet_from_name(name: str) -> tuple[str, list[str]]:
    diets: list[str] = []
    clean = name
    if re.search(r"\(vgn\)", clean, re.I):
        diets.append("vegan")
        clean = re.sub(r"\s*\(vgn\)", "", clean, flags=re.I)
    elif re.search(r"\(v\)", clean, re.I):
        diets.append("vegetarian")
        clean = re.sub(r"\s*\(v\)", "", clean, flags=re.I)
    clean = re.sub(r"\s*\([^)]*nuts?\)", "", clean, flags=re.I).strip()
    allergens = []
    if re.search(r"nuts?", name, re.I) and "coconut" not in name.lower():
        allergens.append("tree_nuts")
    return clean.strip(), diets


def parse_hall_meal(html: str) -> list[tuple[str, str, list[str]]]:
    """Return (station, name, diets) rows from one hall/meal HTML page."""
    rows: list[tuple[str, str, list[str]]] = []
    station = "Other"
    # Prefer the menu column body after the hall heading.
    body = html
    m = re.search(r"dc-menu|panel-body meal|class=['\"]panel-body['\"]", html, re.I)
    if m:
        body = html[m.start():]
    for kind, text in re.findall(r"<(dt|dd)>(.*?)</\1>", body, re.I | re.S):
        val = unescape(re.sub(r"<[^>]+>", "", text)).strip()
        if not val:
            continue
        if kind.lower() == "dt":
            station = val
            continue
        name, diets = _diet_from_name(val)
        if name:
            rows.append((station, name, diets))
    return rows


def scrape(day: str) -> DayMenu:
    result = DayMenu(
        school=SCHOOL, date=day,
        scraped_at=datetime.now(ZoneInfo("UTC")).isoformat(timespec="seconds"),
        timezone=TIMEZONE,
    )
    session = requests.Session()

    for code, display in HALLS:
        location = Location(name=display, kind="dining_hall")
        for meal_q, period, start, end in MEALS:
            time.sleep(REQUEST_DELAY_S)
            url = f"{MENU_DAY}?dc={code}&m={meal_q}&d={day}"
            page = get(session, url)
            if page is None:
                continue
            rows = parse_hall_meal(page.text)
            if not rows:
                continue
            meal = Meal(period=period, raw_period=period, start=start, end=end)
            seen: set[tuple[str, str]] = set()
            for station, name, diets in rows:
                key = (name.lower(), station.lower())
                if key in seen:
                    continue
                seen.add(key)
                item = MenuItem(
                    name=name,
                    station=station,
                    station_type=classify_station(station),
                    dish_key=make_dish_key(SCHOOL, name),
                    nutrition=Nutrition(),
                    diets=diets,
                )
                meal.items.append(apply_tags(item))
            if meal.items:
                location.meals.append(meal)

        if location.meals:
            location.meals.sort(key=lambda m: m.start or "99:99")
            n = sum(len(m.items) for m in location.meals)
            log.info("%s: %d meals, %d items", location.name, len(location.meals), n)
            result.locations.append(location)

    return result
