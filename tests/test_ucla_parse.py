"""UCLA glance HTML parsing (no network)."""
from scraper.schools import ucla

SAMPLE = """
<h2>BREAKFAST MENU FOR TODAY, NOVEMBER 17, 2026</h2>
<h3>De Neve Dining</h3>
<div class='at-a-glance-menu__meal-station'><h4>The Kitchen</h4>
<ul>
<li><a href='/menu-item/?recipe=6542'>Scrambled Eggs</a>
<img class='meal-station__allergen-icon' title='Vegetarian' alt='Vegetarian'
     src='../../wp-content/plugins/jamix/src/blocks/jamix-menu/images/allergens/vegetarian.svg'>
<img class='meal-station__allergen-icon' title='Eggs' alt='Eggs'
     src='../../wp-content/plugins/jamix/src/blocks/jamix-menu/images/allergens/eggs.svg'></li>
<li><a href='/menu-item/?recipe=7110'>Maple Flavored Syrup</a>
<img alt='Vegan' src='../../wp-content/plugins/jamix/src/blocks/jamix-menu/images/allergens/vegan.svg'></li>
</ul></div>
<h2>LUNCH MENU FOR TODAY, NOVEMBER 17, 2026</h2>
<h3>Bruin Plate</h3>
<div class='at-a-glance-menu__meal-station'><h4>Harvest</h4>
<ul><li><a href='/menu-item/?recipe=100'>Tofu Bowl</a>
<img alt='Vegan' src='../../wp-content/plugins/jamix/src/blocks/jamix-menu/images/allergens/vegan.svg'></li></ul></div>
"""


def test_parse_glance_halls_and_flags():
    locs = {l.name: l for l in ucla.parse_glance(SAMPLE)}
    assert set(locs) == {"De Neve", "Bruin Plate"}
    eggs = locs["De Neve"].meals[0].items[0]
    assert eggs.name == "Scrambled Eggs"
    assert eggs.station == "The Kitchen"
    assert "vegetarian" in eggs.diets
    assert "egg" in eggs.allergens
    assert eggs.source_id == "6542"
    tofu = locs["Bruin Plate"].meals[0].items[0]
    assert tofu.name == "Tofu Bowl"
    assert "vegan" in tofu.diets


def test_parse_recipe_nutrition():
    html = """
    <strong>Serving Size:</strong> 6.82oz
    <p class='single-calories'><span>Calories</span>356</p>
    <span>Total Fat</span>20.88g</td>
    <span>Protein</span>13.41g</td>
    <span>Total Carbohydrate</span>28.19g</td>
    <span>Sodium</span>559.84mg</td>
    """
    n = ucla.parse_recipe_nutrition(html)
    assert n.kcal == 356
    assert n.protein_g == 13.4
    assert n.fat_g == 20.9
    assert "6.82oz" in n.serving
