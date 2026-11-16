/* =====================================================================
   PROFILE: daily calorie and protein goals

   Two ways to get a goal:
     1. Fill in a few details and the app SUGGESTS one, or
     2. Type your own number, which always wins over the suggestion.

   The suggestion uses the Mifflin-St Jeor equation, the standard
   estimate dietitians start from:
       energy at rest = 10 x kg + 6.25 x cm - 5 x age  (+5 men, -161 women)
   multiplied by how active you are. It's an estimate, not a measurement.

   Everything is stored on this phone only.
   ===================================================================== */

const STORE_KEY = "campus-menus.profile";
const BOOST_KEY = "campus-menus.day-boost";
const OLD_PROTEIN_KEY = "campus-menus.protein-goal";

export const ACTIVITY = {
  low:      { label: "Mostly sitting",  factor: 1.3 },
  light:    { label: "Lightly active",  factor: 1.45 },
  moderate: { label: "Active",          factor: 1.6 },
  high:     { label: "Very active",     factor: 1.8 },
};

/* `energy` scales calories; `protein` is grams per pound of body weight. */
export const AIMS = {
  maintain: { label: "Maintain",     energy: 1.0,  protein: 0.7 },
  build:    { label: "Build muscle", energy: 1.1,  protein: 0.8 },
  lean:     { label: "Lean out",     energy: 0.88, protein: 0.8 },
};

/* Bump for days you train hard. Only ever upward: the app never tells
   anyone to eat less than their usual goal. */
export const BOOSTS = [
  { value: 0,    label: "Normal day" },
  { value: 0.15, label: "Active +15%" },
  { value: 0.3,  label: "Big day +30%" },
];

export const LIMITS = { calories: [1200, 6000], protein: [20, 300] };
const SUGGEST_FLOOR = 1500;   // never suggest fewer calories than this

export const EMPTY = {
  sex: "", weightLb: null, heightIn: null, age: null,
  activity: "light", aim: "maintain",
  customCalories: null, customProtein: null,
};

const clamp = (x, [lo, hi]) => Math.max(lo, Math.min(hi, x));
const roundTo = (x, step) => Math.round(x / step) * step;

/* ---------------------------------------------------------------------
   Suggested goals from the profile. Returns null for anything we don't
   have enough information to estimate.
   --------------------------------------------------------------------- */
export function suggest(profile) {
  const { weightLb, heightIn, age, sex } = profile;
  const aim = AIMS[profile.aim] || AIMS.maintain;
  const out = { calories: null, protein: null };

  if (weightLb) out.protein = clamp(roundTo(weightLb * aim.protein, 5), LIMITS.protein);

  if (weightLb && heightIn && age) {
    const kg = weightLb * 0.4536, cm = heightIn * 2.54;
    // No sex given: use the midpoint of the two versions of the formula.
    const offset = sex === "male" ? 5 : sex === "female" ? -161 : -78;
    const atRest = 10 * kg + 6.25 * cm - 5 * age + offset;
    const activity = (ACTIVITY[profile.activity] || ACTIVITY.light).factor;
    // Never suggest less than the body uses at rest, or less than the floor.
    const target = Math.max(atRest * activity * aim.energy, atRest, SUGGEST_FLOOR);
    out.calories = clamp(roundTo(target, 50), LIMITS.calories);
  }
  return out;
}

/* ---------------------------------------------------------------------
   Today's goals: your own number if you typed one, else the suggestion,
   then the day's bump on calories.
   Returns { calories, protein, base, custom: {calories, protein} }
   where a goal is null when it isn't set at all.
   --------------------------------------------------------------------- */
export function goalsFor(profile, boost = 0) {
  const s = suggest(profile);
  const base = profile.customCalories || s.calories;
  return {
    calories: base ? roundTo(base * (1 + boost), 10) : null,
    protein: profile.customProtein || s.protein,
    base,
    custom: { calories: !!profile.customCalories, protein: !!profile.customProtein },
  };
}

// Tidy whatever the form sent: numbers in range, unknown choices dropped.
export function clean(raw) {
  const num = (v, lo, hi) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  return {
    sex: ["male", "female"].includes(raw.sex) ? raw.sex : "",
    weightLb: num(raw.weightLb, 70, 500),
    heightIn: num(raw.heightIn, 48, 90),
    age: num(raw.age, 16, 90),
    activity: ACTIVITY[raw.activity] ? raw.activity : "light",
    aim: AIMS[raw.aim] ? raw.aim : "maintain",
    customCalories: raw.customCalories ? clamp(Math.round(Number(raw.customCalories)) || 0, LIMITS.calories) : null,
    customProtein: raw.customProtein ? clamp(Math.round(Number(raw.customProtein)) || 0, LIMITS.protein) : null,
  };
}

/* ---------------------------- storage -------------------------------- */
export function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved) return { ...EMPTY, ...saved };
    // Carry over a protein goal set in the earlier version of the app.
    const old = Number(localStorage.getItem(OLD_PROTEIN_KEY)) || 0;
    return { ...EMPTY, customProtein: old ? clamp(old, LIMITS.protein) : null };
  } catch { return { ...EMPTY }; }
}

export function saveProfile(profile) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(profile)); } catch { /* ignore */ }
}

export function clearProfile() {
  try {
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(OLD_PROTEIN_KEY);
    localStorage.removeItem(BOOST_KEY);
  } catch { /* ignore */ }
  return { ...EMPTY };
}

// The bump applies to one date only, so tomorrow starts back at normal.
export function loadBoost(date) {
  try {
    const saved = JSON.parse(localStorage.getItem(BOOST_KEY)) || {};
    return saved.date === date ? saved.value : 0;
  } catch { return 0; }
}

export function saveBoost(date, value) {
  try { localStorage.setItem(BOOST_KEY, JSON.stringify({ date, value })); } catch { /* ignore */ }
}
