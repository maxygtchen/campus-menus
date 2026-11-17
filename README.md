# campus-menus

Pulls daily dining hall menus, with full nutrition, into one clean JSON format
that the app reads. Supports Berkeley plus UCLA, UCSD, UCI, UCSB, UCD, and UCSC.

## Run it

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m scraper.run              # Berkeley, today
python -m scraper.run --school ucla
python -m scraper.run --school all --days 3
```

Output lands in `docs/data/<school>/<date>.json` (and `today.json`).
Before deploying, put your real contact email in the scraper User-Agent
headers so dining services know who's making the requests.

## Where Berkeley's data comes from

The menus page (`dining.berkeley.edu/menus/`) links to one XML file per
location per day:

```
https://dining.berkeley.edu/wp-content/uploads/menus-exportimport/Crossroads_20261115.xml
```

Each file has every meal period (with start/end times) and every dish with
calories, protein, carbs, fat, fiber, sugar, sodium, carbon footprint,
12 allergen flags and vegan/vegetarian/halal/kosher flags. One request per
location per day; the scraper waits a second between requests.

Berkeley's export is **incomplete for tracking**: breakfast at a hall often
omits the Salad Bar / fruit that lunch lists, and **beverages never appear**.
After each location is parsed, `scraper/always_available.py` copies the
fullest salad/deli/cold-bar/fruit/yogurt list onto every meal at that hall, and
appends drinks from `scraper/data/berkeley/beverages.json` (edit to add more).

Locations seen: Cafe 3, Clark Kerr, Crossroads, Foothill (dining halls) and
Bear Market, Cub Market, The Den (markets).

## Output format

```jsonc
{
  "school": "berkeley",
  "date": "2026-11-15",
  "timezone": "America/Los_Angeles",
  "locations": [{
    "name": "Crossroads",
    "kind": "dining_hall",
    "meals": [{
      "period": "Brunch", "raw_period": "Fall - Brunch",
      "start": "11:00", "end": "16:00",
      "items": [{
        "name": "Texas-style Breakfast Taco",
        "station": "Center Plate",
        "station_type": "main",            // main | side | bar | dessert
        "dish_key": "berkeley:texas-style-breakfast-taco",
        "nutrition": { "kcal": 586.0, "protein_g": 27.8, "carbs_g": 20.8, "fat_g": 43.9, ... },
        "allergens": ["milk", "egg", "wheat", "gluten", "pork"],
        "diets": [],
        "tags": ["high_protein"]
      }]
    }]
  }]
}
```

`dish_key` stays the same every time a dish comes back on the rotation, so
ratings can be keyed on it and used to predict a dining hall's score before
anyone has eaten.

## Running it automatically (free)

Push this folder to a GitHub repo. `.github/workflows/scrape.yml` runs the
scraper twice a day and commits the JSON into `data/`. Your web app can then
read the files straight from GitHub; no server needed yet.

The job fails (and GitHub emails you) when it finds zero items, which means
either the site changed or dining is closed (breaks and holidays).

## Schools

| Id | Source |
| --- | --- |
| `berkeley` | Berkeley Dining XML exports |
| `ucla` | dining.ucla.edu menus-at-a-glance + recipe nutrition |
| `ucsd` | HDH Venue_V3 menus (calories + icons on the listing) |
| `uci` | MyDiningHub / Adobe Elevate GraphQL |
| `ucsb` | apps.dining.ucsb.edu day menu (`?dc=&m=&d=`) |
| `ucd` | housing.ucdavis.edu dining-commons weekly menus |
| `ucsc` | nutrition.sa.ucsc.edu FoodPro shortmenu + labels |

In the app, pick a campus under **Profile → Campus**.

## Adding another school

1. Create `scraper/schools/<school>.py` with `scrape(day) -> DayMenu`
   that returns the same models (`scraper/models.py`).
2. Register it in `scraper/schools/__init__.py` (and `TIMEZONES`).
3. Add an entry in `docs/js/schools.js` so the app can switch to it.

## The app (`docs/`)

GitHub Pages serves the `docs/` folder as the website.

| File | What it does |
| --- | --- |
| `docs/index.html` | Page skeleton and styles |
| `docs/js/app.js` | Loads menus, draws the page, handles taps (start here) |
| `docs/js/scoring.js` | Everyone's dish ratings, hall scores, goal fit |
| `docs/js/taste.js` | Learns what one person likes from their thumbs (on the phone) |
| `docs/js/plate.js` | Meal calculator: plate, meal and day totals |
| `docs/js/profile.js` | Profile and daily calorie/protein goals |
| `docs/js/backend.js` | Where votes are stored (this device, or Supabase) |
| `docs/js/config.js` | Settings and scoring numbers |
| `supabase/schema.sql` | Ratings table and its security rules |

Run it locally with `cd docs && python3 -m http.server 8000`. Add `?demo=1`
to the URL to see it with sample ratings. To make ratings shared between
everyone, follow `SETUP-RATINGS.md`. For accounts (login + sync profile and
plate across devices), follow `SETUP-AUTH.md`.

### Install as an app (PWA)

The site can be added to your home screen (`docs/manifest.webmanifest`,
`docs/sw.js`). The service worker **does not cache JS** — only menu JSON
may be kept for a quick offline peek — so a normal refresh after deploy
still picks up new code.

- **iPhone (Safari):** Share → **Add to Home Screen**
- **Android (Chrome):** Menu → **Install app** or **Add to Home Screen**
- **Desktop Chrome:** Install icon in the address bar (when offered)

Re-run `docs/icons/` PNG generation after changing `icon.svg` (see
`scripts/generate_pwa_icons.py` if added).

## Tests

```bash
pip install pytest && python -m pytest       # scraper
node --test tests/*.test.mjs                 # scoring, taste, plate, profile
```
