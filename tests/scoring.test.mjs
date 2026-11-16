// Run with:  node --test tests/scoring.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../docs/js/config.js";
import { indexScores, dishRating, hallRating, goalScore, topPicks, hallFit, looksReliable }
  from "../docs/js/scoring.js";

const S = CONFIG.scoring;
const dish = (name, kcal, protein, extra = {}) => ({
  name, dish_key: "t:" + name, station: "Center Plate", station_type: "main",
  nutrition: { kcal, protein_g: protein, carbs_g: null, fat_g: null, fiber_g: 0 },
  diets: [], tags: [], allergens: [], ...extra,
});
const row = (name, location, period, is_today, ups, downs) =>
  ({ dish_key: "t:" + name, location, period, is_today, ups, downs });

const chicken = dish("chicken", 260, 34);
const tofu = dish("tofu", 210, 21, { diets: ["vegan"] });
const pasta = dish("pasta", 620, 14, { diets: ["vegetarian"] });
const rice = dish("rice", 150, 3, { diets: ["vegan"] });
const meal = { period: "Dinner", items: [chicken, tofu, pasta, rice] };

test("no votes: score is the prior, nothing shown as live", () => {
  const d = dishRating(indexScores([]), chicken, "Crossroads", "Dinner", S);
  assert.equal(d.score, S.prior);
  assert.equal(d.votes, 0);
});

test("one thumbs-down does not read as 0% liked", () => {
  const idx = indexScores([row("chicken", "Crossroads", "Dinner", true, 0, 1)]);
  const d = dishRating(idx, chicken, "Crossroads", "Dinner", S);
  assert.ok(d.score > 0.35 && d.score < S.prior);
});

test("tonight's votes outweigh history; other halls count half; other meals today are ignored", () => {
  const idx = indexScores([
    row("chicken", "Crossroads", "Dinner", false, 10, 0),  // past, same hall
    row("chicken", "Foothill", "Dinner", false, 0, 4),     // past, other hall (x0.5)
    row("chicken", "Crossroads", "Dinner", true, 0, 5),    // tonight (x3)
    row("chicken", "Crossroads", "Lunch", true, 9, 0),     // today's lunch: ignored for dinner
    row("chicken", "Foothill", "Dinner", true, 9, 0),      // tonight elsewhere: ignored
  ]);
  const d = dishRating(idx, chicken, "Crossroads", "Dinner", S);
  assert.equal(d.ups, 10);
  assert.equal(d.downs, 0.5 * 4 + 3 * 5);
  assert.equal(d.votes, 19);
  assert.equal(d.live, 5);
});

test("hall score: hidden until enough votes, predicted from history, live once tonight's votes arrive", () => {
  assert.equal(hallRating(indexScores([]), meal, "Crossroads", S).kind, null);
  const past = [row("chicken", "Crossroads", "Dinner", false, 9, 1), row("tofu", "Crossroads", "Dinner", false, 3, 2)];
  const predicted = hallRating(indexScores(past), meal, "Crossroads", S);
  assert.equal(predicted.kind, "predicted");
  assert.equal(predicted.votes, 15);
  const live = hallRating(indexScores([...past, row("pasta", "Crossroads", "Dinner", true, 1, 5)]), meal, "Crossroads", S);
  assert.equal(live.kind, "live");
  assert.ok(live.score < predicted.score, "bad votes tonight pull the score down");
});

test("hall score ignores sides and counts a repeated dish once", () => {
  const side = { ...dish("spinach", 7, 1), station_type: "bar" };
  const m = { period: "Dinner", items: [chicken, chicken, side] };
  const idx = indexScores([row("chicken", "X", "Dinner", false, 8, 0), row("spinach", "X", "Dinner", false, 0, 50)]);
  const r = hallRating(idx, m, "X", S);
  assert.equal(r.votes, 8);
});

test("goals rank the right dishes first", () => {
  const idx = indexScores([]);
  const names = (goal) => topPicks(idx, meal, "X", goal, S).map((p) => p.item.name);
  assert.deepEqual(names("muscle"), ["chicken", "tofu", "pasta"]);
  assert.equal(names("lighter")[0], "chicken");
  assert.ok(!names("lighter").includes("pasta"), "620 cal is not a lighter pick");
  assert.deepEqual(names("plants"), ["tofu", "pasta", "rice"]);
  assert.equal(names("balanced")[0], "chicken");
});

test("ratings nudge picks: a well-liked dish beats a slightly better fit that people dislike", () => {
  const a = dish("a", 300, 30), b = dish("b", 300, 27);
  const idx = indexScores([row("a", "X", "Dinner", false, 1, 14), row("b", "X", "Dinner", false, 14, 1)]);
  const picks = topPicks(idx, { period: "Dinner", items: [a, b] }, "X", "muscle", S);
  assert.equal(picks[0].item.name, "b");
});

test("unreliable nutrition is never recommended", () => {
  const broken = dish("tenders", 293, 30); // macros add up to ~154 cal, label says 293
  broken.nutrition.carbs_g = 5; broken.nutrition.fat_g = 1.5;
  assert.equal(looksReliable(broken), false);
  assert.equal(goalScore(indexScores([]), broken, "X", "Dinner", "muscle", S), 0);
  assert.equal(looksReliable(dish("no-data", null, null)), false);
});

test("a hall with three good options beats a hall with one great one", () => {
  const idx = indexScores([]);
  const deep = { period: "Dinner", items: [dish("a", 300, 28), dish("b", 300, 27), dish("c", 300, 26)] };
  const shallow = { period: "Dinner", items: [dish("d", 300, 40), rice] };
  assert.ok(hallFit(idx, deep, "X", "muscle", S).fit > hallFit(idx, shallow, "Y", "muscle", S).fit);
  assert.equal(hallFit(idx, deep, "X", "muscle", S).reason, "3 mains with 20g+ protein");
});
