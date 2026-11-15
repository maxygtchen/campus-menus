import base64
from pathlib import Path

from scraper.schools import berkeley

FIXTURE = Path(__file__).parent / "fixtures" / "crossroads_sample.xml"


def load():
    return berkeley.parse_location_xml(FIXTURE.read_text(encoding="utf-8"))


def test_location_and_meals():
    loc = load()
    assert loc.name == "Crossroads"
    assert loc.kind == "dining_hall"
    assert [m.period for m in loc.meals] == ["Brunch", "Dinner"]
    brunch = loc.meals[0]
    assert (brunch.start, brunch.end) == ("11:00", "16:00")
    assert brunch.raw_period == "Fall - Brunch"


def test_real_recipe_values():
    taco = load().meals[0].items[0]
    assert taco.name == "Texas-style Breakfast Taco"
    assert taco.station == "Center Plate" and taco.station_type == "main"
    assert taco.nutrition.kcal == 586.0
    assert taco.nutrition.protein_g == 27.8
    assert taco.nutrition.carbs_g == 20.8
    assert taco.nutrition.fat_g == 43.9
    assert taco.nutrition.sodium_mg == 1549.0
    assert taco.nutrition.serving == "5.54 oz"
    assert taco.carbon_kg == 0.2  # 0.25 rounded to 1 decimal
    assert taco.allergens == ["milk", "egg", "wheat", "gluten", "pork"]
    assert taco.diets == []
    assert "high_protein" in taco.tags and "lighter" not in taco.tags
    assert taco.dish_key == "berkeley:texas-style-breakfast-taco"


def test_tags_and_station_types():
    items = {i.name: i for i in load().meals[0].items}
    tofu = items["Grilled Paprika Tofu"]
    assert tofu.station_type == "main"
    assert set(tofu.tags) == {"high_protein", "lighter", "vegan"}
    assert items["Baby Spinach"].station_type == "bar"
    assert "lighter" not in items["Baby Spinach"].tags  # only mains get "lighter"
    assert items["Strawberry Shortcake"].station_type == "dessert"
    assert items["Strawberry Shortcake"].diets == ["vegetarian", "halal"]


def test_filters_bad_rows_and_duplicates():
    names = [i.name for i in load().meals[0].items]
    assert names.count("Baby Spinach") == 1        # duplicate dropped
    assert "Bulk Rice Pan" not in names            # bulk serving dropped
    assert "" not in names                         # nameless row dropped
    assert len(names) == 4


def test_discover_stems_from_page_html():
    paths = [
        "/code/wp-content/uploads/menus-exportimport/Cafe_3_20261115.xml",
        "/code/wp-content/uploads/menus-exportimport/Clark_Kerr_Campus_20261115.xml",
    ]
    html = "".join(
        f'<li data-location="{base64.b64encode(p.encode()).decode()}">x</li>' for p in paths
    )
    assert sorted(berkeley.discover_stems(html)) == ["Cafe_3", "Clark_Kerr_Campus"]


def test_urls_for_any_date():
    urls = berkeley.xml_urls_for("2026-11-16", ["Foothill"])
    assert urls == [
        "https://dining.berkeley.edu/wp-content/uploads/menus-exportimport/Foothill_20261116.xml"
    ]


def test_display_name_and_market_kind():
    xml = FIXTURE.read_text().replace('location="Crossroads"', 'location="Clark Kerr Campus"')
    assert berkeley.parse_location_xml(xml).name == "Clark Kerr"
    xml = FIXTURE.read_text().replace('location="Crossroads"', 'location="Bear Market"')
    assert berkeley.parse_location_xml(xml).kind == "market"


def test_bad_xml_returns_none():
    assert berkeley.parse_location_xml("<not xml") is None
    assert berkeley.parse_location_xml("<EatecExchange/>") is None
