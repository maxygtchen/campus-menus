/* =====================================================================
   TASTE: learns what ONE person likes, on their own phone

   Every thumbs up/down is a training example. From those examples a
   small machine-learning model (logistic regression) learns a weight
   for each "feature" of a dish:

       words in the name   chicken, tofu, curry, pizza ...
       the station         grill, pasta, pizza ...
       diet                vegan, vegetarian
       rough nutrition     high protein, light, hearty

   Liking three chicken dishes pushes the "chicken" weight up, so a
   chicken dish you've never rated gets recommended too. Disliking
   dishes pushes their features down.

   Nothing here leaves the phone. No server, no account, no cost.
   ===================================================================== */

const STORE_KEY = "campus-menus.taste";

// Words that say nothing about taste.
const SKIP = new Set(["with", "and", "the", "for", "style", "halal", "kosher", "vegan",
  "vegetarian", "option", "house", "made", "fresh", "our", "own", "side", "plain"]);
// Words that are real features but make odd explanations ("you like baked").
const NOT_A_REASON = new Set(["baked", "roasted", "fried", "grilled", "steamed", "sauteed",
  "herb", "sauce", "style", "hot", "braised", "crispy", "seasoned"]);

/* ---------------------------------------------------------------------
   Features: turn a dish into a list of labels the model can learn from.
   --------------------------------------------------------------------- */
export function wordsOf(name) {
  return [...new Set(
    name.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/)
      .filter((w) => w.length >= 3 && !SKIP.has(w))
      .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
  )];
}

export function featuresOf(item) {
  const f = wordsOf(item.name).map((w) => "word:" + w);
  f.push("station:" + item.station.toLowerCase().replace(/[^a-z]/g, ""));
  if (item.diets.includes("vegan")) f.push("diet:vegan");
  else if (item.diets.includes("vegetarian")) f.push("diet:vegetarian");
  const n = item.nutrition;
  if (n.protein_g >= 20) f.push("nutrition:high-protein");
  if (n.kcal != null && n.kcal <= 250) f.push("nutrition:light");
  if (n.kcal >= 500) f.push("nutrition:hearty");
  return f;
}

/* ---------------------------------------------------------------------
   Training. `examples` is a list of { f: [features], v: 1 or -1 }.

   Logistic regression in one paragraph: each feature has a weight.
   Add up the weights of a dish's features, squash the sum into 0..1
   (the "sigmoid"), and that's the predicted chance you like it. To
   train, repeatedly nudge every weight in the direction that makes the
   predictions closer to your real votes ("gradient descent"). The
   `shrink` term pulls weights back toward zero so one vote can't swing
   everything.
   --------------------------------------------------------------------- */
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

export function train(examples, { steps = 300, rate = 0.5, caution = 0.8 } = {}) {
  const weights = new Map();
  let bias = 0;
  const n = examples.length;
  if (n === 0) return { weights, bias, n };
  // Fewer ratings = more caution: with 1 rating the pull toward zero is
  // strong, with 20 it is gentle.
  const shrink = caution / n;

  for (let step = 0; step < steps; step++) {
    const grad = new Map();
    let gradBias = 0;
    for (const ex of examples) {
      let z = bias;
      for (const f of ex.f) z += weights.get(f) || 0;
      const error = sigmoid(z) - (ex.v > 0 ? 1 : 0);   // how wrong, and which way
      gradBias += error;
      for (const f of ex.f) grad.set(f, (grad.get(f) || 0) + error);
    }
    bias -= rate * (gradBias / n + shrink * bias);
    for (const [f, g] of grad) {
      const w = weights.get(f) || 0;
      weights.set(f, w - rate * (g / n + shrink * w));
    }
  }
  return { weights, bias, n };
}

/* ---------------------------------------------------------------------
   Predicting. Returns:
     p       0..1, the chance this person likes the dish (0.5 = no idea)
     direct  1 / -1 if they rated this exact dish before, else 0
     why     up to two words that drove a positive prediction
   --------------------------------------------------------------------- */
export function predict(model, votes, item) {
  const direct = votes[item.dish_key] ? votes[item.dish_key].v : 0;
  if (model.n === 0) return { p: 0.5, direct, why: [] };

  const features = featuresOf(item);
  let z = model.bias;
  for (const f of features) z += model.weights.get(f) || 0;
  let p = sigmoid(z);

  // Your own verdict on this exact dish beats any guess.
  if (direct > 0) p = Math.max(p, 0.92);
  if (direct < 0) p = Math.min(p, 0.06);

  const why = features
    .filter((f) => f.startsWith("word:") && !NOT_A_REASON.has(f.slice(5)))
    .map((f) => ({ word: f.slice(5), w: model.weights.get(f) || 0 }))
    .filter((x) => x.w > 0.12)
    .sort((a, b) => b.w - a.w)
    .slice(0, 2)
    .map((x) => x.word);
  return { p, direct, why };
}

/* ---------------------------------------------------------------------
   Blending. `base` is the goal + everyone's ratings (0..1); `taste` is
   what predict() returned for this person.

     - You liked this exact dish before:   straight to the top
     - You thumbed it down before:         straight to the bottom
     - Otherwise: with few ratings we mostly trust `base`. As you rate
       more, your own taste takes over, up to 70% after 6 ratings.
   --------------------------------------------------------------------- */
export function blend(base, taste, ratedCount) {
  if (taste.direct > 0) return 0.9 + 0.1 * base;
  if (taste.direct < 0) return 0.05 * base;
  const trust = 0.7 * Math.min(1, ratedCount / 6);
  return (1 - trust) * base + trust * taste.p;
}

/* ---------------------------------------------------------------------
   Storage: { dish_key: { v: 1|-1, f: [features], name, t: date } }
   One entry per dish: your latest verdict on it.
   --------------------------------------------------------------------- */
export function loadTaste() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch { return {}; }
}

export function recordTaste(votes, item, vote, date) {
  if (vote === 0) delete votes[item.dish_key];
  else votes[item.dish_key] = { v: vote, f: featuresOf(item), name: item.name, t: date };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(votes)); } catch { /* ignore */ }
  return votes;
}

export const trainFromVotes = (votes) => train(Object.values(votes));
