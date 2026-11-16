// Run with:  node --test tests/profile.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { suggest, goalsFor, clean, EMPTY } from "../docs/js/profile.js";

const guy = { ...EMPTY, sex: "male", weightLb: 160, heightIn: 70, age: 19, activity: "moderate" };

test("nothing filled in: no goals at all", () => {
  assert.deepEqual(suggest(EMPTY), { calories: null, protein: null });
  assert.equal(goalsFor(EMPTY).calories, null);
  assert.equal(goalsFor(EMPTY).protein, null);
});

test("weight alone is enough for a protein suggestion, not calories", () => {
  const s = suggest({ ...EMPTY, weightLb: 160 });
  assert.equal(s.protein, 110);        // 160 lb x 0.7 = 112, rounded to 5
  assert.equal(s.calories, null);
});

test("full profile: matches the Mifflin-St Jeor equation by hand", () => {
  // 10*72.576 + 6.25*177.8 - 5*19 + 5 = 1747.0 at rest; x1.6 = 2795 -> 2800
  assert.equal(suggest(guy).calories, 2800);
  // same person, female offset: 1581.0 x 1.6 = 2530 -> 2550
  assert.equal(suggest({ ...guy, sex: "female" }).calories, 2550);
  // no sex given sits between the two
  const mid = suggest({ ...guy, sex: "" }).calories;
  assert.ok(mid > 2550 && mid < 2800);
});

test("aims move the numbers the right way", () => {
  const maintain = suggest(guy), build = suggest({ ...guy, aim: "build" }), lean = suggest({ ...guy, aim: "lean" });
  assert.ok(build.calories > maintain.calories && lean.calories < maintain.calories);
  assert.ok(build.protein > maintain.protein);
  assert.equal(lean.protein, 130);     // 160 x 0.8 = 128 -> 130
});

test("safety floor: never suggests below resting energy or below 1500", () => {
  const small = { ...EMPTY, sex: "female", weightLb: 100, heightIn: 60, age: 19, activity: "low", aim: "lean" };
  const atRest = 10 * 45.36 + 6.25 * 152.4 - 5 * 19 - 161;      // about 1150
  assert.ok(atRest < 1500);
  assert.equal(suggest(small).calories, 1500);
  const big = { ...guy, weightLb: 240, heightIn: 76, activity: "low", aim: "lean" };
  const bigRest = 10 * 240 * 0.4536 + 6.25 * 76 * 2.54 - 5 * 19 + 5;
  assert.ok(suggest(big).calories >= Math.floor(bigRest / 50) * 50);
});

test("your own number beats the suggestion", () => {
  const g = goalsFor({ ...guy, customCalories: 3000, customProtein: 150 });
  assert.equal(g.calories, 3000);
  assert.equal(g.protein, 150);
  assert.deepEqual(g.custom, { calories: true, protein: true });
  assert.deepEqual(goalsFor(guy).custom, { calories: false, protein: false });
});

test("an active day raises calories only, and only for that day's total", () => {
  const normal = goalsFor(guy, 0), active = goalsFor(guy, 0.15);
  assert.equal(active.calories, 3220);          // 2800 x 1.15
  assert.equal(active.base, 2800);
  assert.equal(active.protein, normal.protein);
});

test("form input is cleaned: junk dropped, numbers kept in range", () => {
  const c = clean({ sex: "robot", weightLb: "160", heightIn: "70", age: "9", activity: "x", aim: "y",
                    customCalories: "300", customProtein: "999" });
  assert.equal(c.sex, "");
  assert.equal(c.weightLb, 160);
  assert.equal(c.age, null);                    // out of range, ignored
  assert.equal(c.activity, "light");
  assert.equal(c.aim, "maintain");
  assert.equal(c.customCalories, 1200);         // raised to the minimum
  assert.equal(c.customProtein, 300);           // capped
  assert.equal(clean({ customCalories: "" }).customCalories, null);
});
