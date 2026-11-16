/* =====================================================================
   SCORING: the "brain" of the app
   Pure functions only: data in, numbers out. Nothing here touches the
   page or the network, which is why it can be tested on its own
   (see tests/scoring.test.mjs).

   Three questions it answers:
     1. How much do people like this dish?           -> dishRating()
     2. How good is this dining hall for this meal?  -> hallRating()
     3. What fits MY goal here?                      -> topPicks(), hallFit()
   ===================================================================== */

/* ---------------------------------------------------------------------
   Goals. A goal reorders dishes; it never hides food or labels it "bad".
   `fit` returns 0 to 1: how well one dish matches the goal.
   --------------------------------------------------------------------- */
export const GOALS = {
  balanced: {
    label: "Eat well",
    fit: (n) => 0.5 + Math.min(0.5, n.protein_g / 40),
    reason: (count) => `${count} solid main${count === 1 ? "" : "s"}`,
    counts: (item) => item.nutrition.protein_g >= 15,
  },
  muscle: {
    label: "Build muscle",
    fit: (n) => (n.protein_g < 12 ? 0 : Math.min(1, n.protein_g / 35)),
    reason: (count) => `${count} main${count === 1 ? "" : "s"} with 20g+ protein`,
    counts: (item) => item.nutrition.protein_g >= 20,
  },
  lighter: {
    label: "Eat lighter",
    // Lighter but still filling: protein and fiber are what keep you full.
    fit: (n) => (n.kcal > 450 ? 0 : Math.min(1, (n.protein_g + (n.fiber_g || 0)) / 25)),
    reason: (count) => `${count} lighter main${count === 1 ? "" : "s"} that still fill you up`,
    counts: (item) => item.nutrition.kcal <= 450 && item.nutrition.protein_g >= 12,
  },
  plants: {
    label: "Plant-based",
    fit: (n, item) => (isPlantBased(item) ? Math.max(0.2, Math.min(1, n.protein_g / 25)) : 0),
    reason: (count) => `${count} vegan or vegetarian main${count === 1 ? "" : "s"}`,
    counts: (item) => isPlantBased(item),
  },
};

function isPlantBased(item) {
  return item.diets.includes("vegan") || item.diets.includes("vegetarian");
}

/* ---------------------------------------------------------------------
   Data check. The source data sometimes has mistakes. Calories should
   roughly equal 4 x protein + 4 x carbs + 9 x fat. If they're far apart,
   don't recommend the dish based on numbers we can't trust.
   --------------------------------------------------------------------- */
export function looksReliable(item) {
  const n = item.nutrition;
  if (n.kcal == null || n.protein_g == null || n.kcal <= 0) return false;
  if (n.carbs_g == null || n.fat_g == null) return true; // can't check, allow
  const fromMacros = 4 * n.protein_g + 4 * n.carbs_g + 9 * n.fat_g;
  return Math.abs(fromMacros - n.kcal) <= Math.max(40, 0.3 * n.kcal);
}

/* ---------------------------------------------------------------------
   Ratings index. The backend returns rows like
     { dish_key, location, period, is_today, ups, downs }
   Group them by dish so lookups are fast.
   --------------------------------------------------------------------- */
export function indexScores(rows) {
  const byDish = new Map();
  for (const row of rows || []) {
    if (!byDish.has(row.dish_key)) byDish.set(row.dish_key, []);
    byDish.get(row.dish_key).push(row);
  }
  return byDish;
}

/* ---------------------------------------------------------------------
   1. How much do people like this dish, here, at this meal?

   Votes are weighted:
     - from this exact meal (today, this hall, this period): x todayWeight
     - past votes at this hall:                              x 1
     - past votes for the same dish at another hall:         x otherHallWeight

   Then "smoothing": we start from a prior guess (70% liked, worth 4
   votes) so that a single thumbs-down doesn't show as "0% liked".
   --------------------------------------------------------------------- */
export function dishRating(index, item, location, period, cfg) {
  const rows = index.get(item.dish_key) || [];
  let ups = 0, downs = 0;      // weighted, used for the score
  let votes = 0, live = 0;     // real head counts, shown to people

  for (const r of rows) {
    const n = r.ups + r.downs;
    let w;
    if (r.is_today) {
      if (r.location !== location || r.period !== period) continue; // other meal today
      w = cfg.todayWeight;
      live += n;
    } else {
      w = r.location === location ? 1 : cfg.otherHallWeight;
    }
    ups += w * r.ups;
    downs += w * r.downs;
    votes += n;
  }

  const score = (ups + cfg.prior * cfg.priorWeight) / (ups + downs + cfg.priorWeight);
  return { score, votes, live, ups, downs };
}

/* ---------------------------------------------------------------------
   2. How good is this hall for this meal?
   Pool the votes of every MAIN dish being served (nobody picks a hall
   for its salad bar). Because menus rotate, past votes let us predict
   a score before anyone has eaten; votes from the meal itself then
   pull it up or down live.
   kind: "live" | "predicted" | null (not enough votes to show)
   --------------------------------------------------------------------- */
export function hallRating(index, meal, location, cfg) {
  let ups = 0, downs = 0, votes = 0, live = 0;
  const seen = new Set();
  for (const item of meal.items) {
    if (item.station_type !== "main" || seen.has(item.dish_key)) continue;
    seen.add(item.dish_key);
    const d = dishRating(index, item, location, meal.period, cfg);
    ups += d.ups; downs += d.downs; votes += d.votes; live += d.live;
  }
  const score = (ups + cfg.prior * cfg.priorWeight) / (ups + downs + cfg.priorWeight);
  let kind = null;
  if (votes >= cfg.minVotesHall) kind = live >= cfg.liveVotes ? "live" : "predicted";
  return { score, votes, live, kind };
}

/* ---------------------------------------------------------------------
   3. What fits my goal?
   A dish's final score = how well it fits the goal, nudged by how much
   people like it (60% fit, up to 40% from ratings).
   --------------------------------------------------------------------- */
export function goalScore(index, item, location, period, goalKey, cfg) {
  if (item.station_type !== "main" || !looksReliable(item)) return 0;
  const fit = GOALS[goalKey].fit(item.nutrition, item);
  if (fit <= 0) return 0;
  const liked = dishRating(index, item, location, period, cfg).score;
  return fit * (0.6 + 0.4 * liked);
}

// The best few mains at one hall for a goal, best first.
export function topPicks(index, meal, location, goalKey, cfg, howMany = 3) {
  const best = new Map(); // dish_key -> { item, score }, so a dish listed twice counts once
  for (const item of meal.items) {
    const score = goalScore(index, item, location, meal.period, goalKey, cfg);
    if (score <= 0) continue;
    const prev = best.get(item.dish_key);
    if (!prev || score > prev.score) best.set(item.dish_key, { item, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, howMany);
}

// One number per hall: the average of its top 3 picks (a missing pick
// counts as 0, so a hall with three good options beats a hall with one).
export function hallFit(index, meal, location, goalKey, cfg) {
  const picks = topPicks(index, meal, location, goalKey, cfg, 3);
  const fit = picks.reduce((sum, p) => sum + p.score, 0) / 3;
  const seen = new Set();
  let matches = 0;
  for (const item of meal.items) {
    if (item.station_type !== "main" || seen.has(item.dish_key) || !looksReliable(item)) continue;
    seen.add(item.dish_key);
    if (GOALS[goalKey].counts(item)) matches++;
  }
  return { fit, picks, matches, reason: GOALS[goalKey].reason(matches) };
}
