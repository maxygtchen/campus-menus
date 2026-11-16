// Run with:  node --test tests/taste.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { wordsOf, featuresOf, train, predict, blend } from "../docs/js/taste.js";

const dish = (name, extra = {}) => ({
  name, dish_key: "t:" + name.toLowerCase().replace(/[^a-z]+/g, "-"),
  station: "Center Plate", diets: [], nutrition: { kcal: 300, protein_g: 15 }, ...extra,
});
const votesFrom = (pairs) => Object.fromEntries(pairs.map(([d, v]) =>
  [d.dish_key, { v, f: featuresOf(d), name: d.name }]));
const model = (votes) => train(Object.values(votes));

test("words: lowercased, plurals merged, filler dropped", () => {
  assert.deepEqual(wordsOf('Halal Chicken Tenders with BBQ Sauce'), ["chicken", "tender", "bbq", "sauce"]);
  assert.deepEqual(wordsOf('Vegan Broccoli "Beef"'), ["broccoli", "beef"]);
});

test("no ratings yet: everything is a coin flip", () => {
  const r = predict(model({}), {}, dish("Chicken Tikka Masala"));
  assert.equal(r.p, 0.5);
  assert.deepEqual(r.why, []);
});

test("likes generalise: liking chicken dishes lifts a chicken dish never rated", () => {
  const votes = votesFrom([
    [dish("Herb Roasted Chicken Thigh"), 1], [dish("Chicken Tikka Masala"), 1],
    [dish("Lemongrass Chicken"), 1],
    [dish("Baked Tofu Piccata"), -1], [dish("Fried Teriyaki Tofu"), -1],
  ]);
  const m = model(votes);
  const chicken = predict(m, votes, dish("Grilled Chicken Breast"));
  const tofu = predict(m, votes, dish("Lemongrass Tofu Bowl"));
  const unknown = predict(m, votes, dish("Navy Beans"));
  assert.ok(chicken.p > 0.62, `chicken ${chicken.p}`);
  assert.ok(tofu.p < 0.5, `tofu ${tofu.p}`);
  assert.ok(chicken.p > unknown.p && unknown.p > tofu.p, "unknown dishes sit in between");
  assert.deepEqual(chicken.why, ["chicken"]);
  assert.equal(chicken.direct, 0);
});

test("your own verdict on the exact dish wins over the guess", () => {
  const liked = dish("Tofu Scramble"), hated = dish("Chicken Liver");
  const votes = votesFrom([
    [dish("Roasted Chicken"), 1], [dish("Chicken Curry"), 1], [hated, -1],
    [dish("Baked Tofu"), -1], [dish("Tofu Stir Fry"), -1], [liked, 1],
  ]);
  const m = model(votes);
  assert.ok(predict(m, votes, liked).p >= 0.92);
  assert.equal(predict(m, votes, liked).direct, 1);
  assert.ok(predict(m, votes, hated).p <= 0.06);
});

test("one rating nudges, it doesn't take over", () => {
  const votes = votesFrom([[dish("Pepperoni Pizza"), -1]]);
  const p = predict(model(votes), votes, dish("Cheese Pizza")).p;
  assert.ok(p < 0.5 && p > 0.25, `one dislike should be a nudge, got ${p}`);
});

test("station and diet are learned too", () => {
  const veg = (name) => dish(name, { diets: ["vegan"] });
  const votes = votesFrom([[veg("Lentil Dal"), 1], [veg("Chana Masala"), 1], [veg("Mushroom Ragu"), 1],
                           [dish("Pork Carnitas"), -1], [dish("Beef Stew"), -1]]);
  const m = model(votes);
  assert.ok(predict(m, votes, veg("Quinoa Pilaf")).p > predict(m, votes, dish("Quinoa Pilaf")).p);
});

test("blend: taste counts for nothing at 0 ratings and at most 70% from 6 ratings on", () => {
  const guess = (p) => ({ p, direct: 0 });
  assert.equal(blend(0.8, guess(0.1), 0), 0.8);
  assert.ok(Math.abs(blend(0.8, guess(0.1), 6) - (0.3 * 0.8 + 0.7 * 0.1)) < 1e-9);
  assert.equal(blend(0.8, guess(0.1), 6), blend(0.8, guess(0.1), 50));
});

test("blend: a dish you liked goes to the top, one you thumbed down goes to the bottom", () => {
  const liked = blend(0.0, { p: 0.92, direct: 1 }, 1);     // poor goal fit, but you like it
  const greatFit = blend(1.0, { p: 0.5, direct: 0 }, 1);
  const disliked = blend(1.0, { p: 0.06, direct: -1 }, 1); // great fit, but you don't like it
  assert.ok(liked >= 0.9 && liked > disliked);
  assert.ok(disliked <= 0.05 && disliked < greatFit);
});
