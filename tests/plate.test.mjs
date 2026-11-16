// Run with:  node --test tests/plate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { adjust, clearMeal, mealEntries, dayEntries, totals, qtyOf, servingsCount, entryKey }
  from "../docs/js/plate.js";

const chicken = { name: "Chicken", dish_key: "t:chicken",
  nutrition: { kcal: 260, protein_g: 34, carbs_g: 3, fat_g: 12, fiber_g: 1, sodium_mg: 420, calcium_mg: 20, serving: "4 oz" } };
const rice = { name: "Rice", dish_key: "t:rice",
  nutrition: { kcal: 150, protein_g: 3, carbs_g: 33, fat_g: 0.5, fiber_g: 0.6, sodium_mg: 5, serving: "4 oz" } }; // no calcium
const D = "2026-11-16", K = (d) => entryKey(d.dish_key, "Crossroads");

test("add, add again, remove; empty meals disappear", () => {
  const p = {};
  adjust(p, D, "Lunch", K(chicken), +1, chicken, "Crossroads");
  adjust(p, D, "Lunch", K(chicken), +1, chicken, "Crossroads");
  assert.equal(qtyOf(p, D, "Lunch", K(chicken)), 2);
  adjust(p, D, "Lunch", K(chicken), -1);
  adjust(p, D, "Lunch", K(chicken), -1);
  assert.deepEqual(p, {});
  adjust(p, D, "Lunch", K(chicken), -1);           // removing what isn't there is harmless
  assert.deepEqual(p, {});
});

test("totals multiply by servings and add across dishes", () => {
  const p = {};
  adjust(p, D, "Lunch", K(chicken), +1, chicken, "Crossroads");
  adjust(p, D, "Lunch", K(chicken), +1, chicken, "Crossroads");
  adjust(p, D, "Lunch", K(rice), +1, rice, "Crossroads");
  const t = totals(mealEntries(p, D, "Lunch"));
  assert.equal(t.kcal.total, 260 * 2 + 150);
  assert.equal(t.protein_g.total, 34 * 2 + 3);
  assert.equal(t.sodium_mg.total, 845);
  assert.equal(servingsCount(mealEntries(p, D, "Lunch")), 3);
});

test("missing numbers are counted, not treated as zero silently", () => {
  const p = {};
  adjust(p, D, "Lunch", K(chicken), +1, chicken, "Crossroads");
  adjust(p, D, "Lunch", K(rice), +1, rice, "Crossroads");
  const t = totals(mealEntries(p, D, "Lunch"));
  assert.deepEqual(t.calcium_mg, { total: 20, missing: 1 });
  assert.equal(t.iron_mg.missing, 2);
  assert.equal(t.kcal.missing, 0);
});

test("day total covers every meal; clearing one meal leaves the others", () => {
  const p = {};
  adjust(p, D, "Lunch", K(chicken), +1, chicken, "Crossroads");
  adjust(p, D, "Dinner", K(rice), +1, rice, "Crossroads");
  adjust(p, "2026-11-17", "Lunch", K(rice), +1, rice, "Crossroads");
  assert.equal(totals(dayEntries(p, D)).kcal.total, 410);
  clearMeal(p, D, "Lunch");
  assert.equal(totals(dayEntries(p, D)).kcal.total, 150);
  assert.equal(totals(dayEntries(p, "2026-11-17")).kcal.total, 150);
});

test("the plate keeps its own copy of the nutrition", () => {
  const p = {};
  const item = structuredClone(chicken);
  adjust(p, D, "Lunch", K(item), +1, item, "Crossroads");
  item.nutrition.kcal = 9999;                       // menu data changes later
  assert.equal(totals(mealEntries(p, D, "Lunch")).kcal.total, 260);
});

test("servings are capped so a stuck finger can't add 500", () => {
  const p = {};
  for (let i = 0; i < 30; i++) adjust(p, D, "Lunch", K(rice), +1, rice, "Crossroads");
  assert.equal(qtyOf(p, D, "Lunch", K(rice)), 9);
});
