from scraper.always_available import enrich_location
from scraper.models import Location, Meal, MenuItem, Nutrition


def _spinach():
    return MenuItem(
        name="Baby Spinach",
        station="Salad Bar",
        station_type="bar",
        dish_key="berkeley:baby-spinach",
        nutrition=Nutrition(kcal=7, serving="1 oz"),
    )


def _main():
    return MenuItem(
        name="Scrambled Eggs",
        station="Center Plate",
        station_type="main",
        dish_key="berkeley:scrambled-eggs",
        nutrition=Nutrition(kcal=180, serving="4 oz"),
    )


def test_copies_salad_bar_onto_breakfast():
    breakfast = Meal(period="Breakfast", raw_period="Fall - Breakfast",
                     start="07:00", end="10:00", items=[_main()])
    lunch = Meal(period="Lunch", raw_period="Fall - Lunch",
                 start="11:00", end="14:00", items=[_spinach(), _main()])
    loc = Location(name="Crossroads", kind="dining_hall", meals=[breakfast, lunch])
    added = enrich_location(loc)
    assert added >= 1
    names = {i.name for i in breakfast.items}
    assert "Baby Spinach" in names


def test_adds_beverages_to_dining_hall():
    breakfast = Meal(period="Breakfast", raw_period="x", start="07:00", end="10:00",
                       items=[_main()])
    loc = Location(name="Foothill", kind="dining_hall", meals=[breakfast])
    enrich_location(loc)
    assert any(i.station == "Beverages" for i in breakfast.items)