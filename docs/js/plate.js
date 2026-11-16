/* =====================================================================
   PLATE: the meal calculator ("shopping cart for a meal")

   Tap + on a dish and it goes on your plate for that meal. The plate
   adds up the nutrition, per meal and for the whole day.

   Stored on this phone as:
     { "2026-11-16": { "Lunch": { "dish_key|Hall": entry, ... }, ... }, ... }
   where an entry is { name, hall, qty, serving, nutrition }.
   We keep a copy of each dish's nutrition so the totals still work
   after the menu changes.
   ===================================================================== */

const STORE_KEY = "campus-menus.plates";
const GOAL_KEY = "campus-menus.protein-goal";
const KEEP_DAYS = 14;

/* What the calculator shows. `dv` = recommended daily value for an adult
   (US nutrition-label values), used for the small "% of daily" figures.
   `limit: true` marks things most people try not to exceed. */
export const NUTRIENTS = [
  { key: "kcal",           label: "Calories",      unit: "",   group: "main" },
  { key: "protein_g",      label: "Protein",       unit: "g",  group: "main" },
  { key: "carbs_g",        label: "Carbs",         unit: "g",  group: "main" },
  { key: "fat_g",          label: "Fat",           unit: "g",  group: "main" },
  { key: "fiber_g",        label: "Fiber",         unit: "g",  group: "more",  dv: 28 },
  { key: "sugar_g",        label: "Sugar",         unit: "g",  group: "more" },
  { key: "sat_fat_g",      label: "Saturated fat", unit: "g",  group: "more",  dv: 20, limit: true },
  { key: "sodium_mg",      label: "Sodium",        unit: "mg", group: "more",  dv: 2300, limit: true },
  { key: "cholesterol_mg", label: "Cholesterol",   unit: "mg", group: "more",  dv: 300, limit: true },
  { key: "calcium_mg",     label: "Calcium",       unit: "mg", group: "micro", dv: 1300 },
  { key: "iron_mg",        label: "Iron",          unit: "mg", group: "micro", dv: 18 },
  { key: "potassium_mg",   label: "Potassium",     unit: "mg", group: "micro", dv: 4700 },
  { key: "vitamin_c_mg",   label: "Vitamin C",     unit: "mg", group: "micro", dv: 90 },
];

/* ---------------------------- storage -------------------------------- */
export function loadPlates() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch { return {}; }
}

export function savePlates(plates, today) {
  // Forget plates older than two weeks so storage never fills up.
  const cutoff = new Date(today + "T12:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() - KEEP_DAYS);
  const oldest = cutoff.toISOString().slice(0, 10);
  for (const day of Object.keys(plates)) if (day < oldest) delete plates[day];
  try { localStorage.setItem(STORE_KEY, JSON.stringify(plates)); } catch { /* ignore */ }
}

export function loadProteinGoal() {
  try { return Number(localStorage.getItem(GOAL_KEY)) || 0; } catch { return 0; }
}
export function saveProteinGoal(grams) {
  try { localStorage.setItem(GOAL_KEY, String(grams || 0)); } catch { /* ignore */ }
}

/* --------------------------- changing it ------------------------------ */
export const entryKey = (dishKey, hall) => dishKey + "|" + hall;

// Add (change = +1) or remove (change = -1) a serving. `item` is only
// needed the first time a dish goes on the plate.
export function adjust(plates, date, period, key, change, item, hall) {
  const day = plates[date] || {};
  const meal = day[period] || {};
  if (!meal[key]) {
    if (change <= 0 || !item) return plates;       // nothing to remove
    meal[key] = { name: item.name, hall, qty: 0, serving: item.nutrition.serving || "",
                  nutrition: { ...item.nutrition } };
  }
  meal[key].qty = Math.min(9, meal[key].qty + change);
  if (meal[key].qty <= 0) delete meal[key];

  // Put the meal back, or tidy away empty meals and days.
  if (Object.keys(meal).length) day[period] = meal; else delete day[period];
  if (Object.keys(day).length) plates[date] = day; else delete plates[date];
  return plates;
}

export function clearMeal(plates, date, period) {
  if (plates[date]) delete plates[date][period];
  if (plates[date] && !Object.keys(plates[date]).length) delete plates[date];
  return plates;
}

/* ---------------------------- reading it ------------------------------ */
// [{ key, period, name, hall, qty, serving, nutrition }] for one meal...
export function mealEntries(plates, date, period) {
  const meal = (plates[date] || {})[period] || {};
  return Object.entries(meal).map(([key, e]) => ({ key, period, ...e }));
}
// ...or for the whole day.
export function dayEntries(plates, date) {
  return Object.keys(plates[date] || {}).flatMap((period) => mealEntries(plates, date, period));
}

export function qtyOf(plates, date, period, key) {
  const e = ((plates[date] || {})[period] || {})[key];
  return e ? e.qty : 0;
}

/* Add everything up. For each nutrient returns
     { total, missing }   missing = how many dishes had no number for it
   so the screen can be honest ("at least 420mg") instead of guessing. */
export function totals(entries) {
  const out = {};
  for (const { key } of NUTRIENTS) out[key] = { total: 0, missing: 0 };
  for (const e of entries) {
    for (const { key } of NUTRIENTS) {
      const value = e.nutrition[key];
      if (value == null) out[key].missing += 1;
      else out[key].total += value * e.qty;
    }
  }
  return out;
}

export const servingsCount = (entries) => entries.reduce((sum, e) => sum + e.qty, 0);
