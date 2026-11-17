/* =====================================================================
   APP: ties everything together

   Read in this order:
     state          everything the app remembers while it's open
     time helpers   "what time is it at Berkeley right now?"
     data loading   fetch the JSON your scraper saved
     meal logic     open / opens soon / closed
     YOUR TURN      filters you'll build
     view model     work out everything the screen needs to show
     rendering      turn that into HTML
     events         what happens when someone taps
     init           runs once when the page loads

   Other files:
     config.js    settings              scoring.js   everyone's ratings + goals
     backend.js   where votes are kept  taste.js     learns what YOU like
     plate.js     the meal calculator   profile.js   daily calorie + protein goals
   ===================================================================== */
import { CONFIG } from "./config.js";
import { createBackend } from "./backend.js";
import { ensureLoggedIn, signOut, supabaseConfigured } from "./auth.js";
import { packUserBlob, pullUserData, schedulePushUserData } from "./userSync.js";
import { GOALS, indexScores, dishRating, hallRating } from "./scoring.js";
import { loadTaste, recordTaste, trainFromVotes, predict, blend } from "./taste.js";
import * as Plate from "./plate.js";
import * as Profile from "./profile.js";

const S = CONFIG.scoring;
const $ = (id) => document.getElementById(id);

const state = {
  menu: null,            // the day's JSON
  hall: null,            // which dining hall is on screen
  homeHall: null,        // the person's default hall (saved on the phone)
  period: null,          // selected meal tab, e.g. "Dinner"
  goal: "balanced",      // selected goal (a key of GOALS)
  filters: {},           // for YOUR TURN
  backend: null,         // where votes are stored

  // Everyone's ratings
  scoreRows: [],         // rating totals from the backend
  scores: new Map(),     // the same totals, indexed by dish (updates as you vote)
  myVotes: new Map(),    // "dish|hall|meal" -> 1 or -1, for today

  // This person's taste (see taste.js)
  taste: {},             // dish -> their verdict
  model: trainFromVotes({}),

  // Frozen sort snapshot so the list doesn't jump under your thumb when you vote.
  rank: { scores: new Map(), taste: {}, model: trainFromVotes({}) },

  // Meal calculator (see plate.js)
  plates: {},
  profile: { ...Profile.EMPTY },   // see profile.js
  boost: 0,              // today's "active day" bump on calories
  sheet: { open: false, scope: "meal" },

  open: new Set(),       // which "Show more" sections are expanded
};

/* =====================================================================
   TIME HELPERS
   Times in the data look like "16:30". Minutes since midnight
   (16*60 + 30 = 990) are much easier to compare than strings.
   ===================================================================== */
function campusNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function toMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function prettyMinutes(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`;
}
const prettyTime = (hhmm) => (toMinutes(hhmm) === null ? "" : prettyMinutes(toMinutes(hhmm)));

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function prettyDate(dateStr) {
  return new Date(dateStr + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
}

/* =====================================================================
   DATA LOADING
   ===================================================================== */
async function loadMenu(dateStr) {
  try {
    const res = await fetch(CONFIG.dataBase + dateStr + ".json", { cache: "no-cache" });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("Could not load menu for", dateStr, err);
    return null;
  }
}

// Ask the backend for everyone's rating totals and this person's own votes.
async function loadRatings() {
  const now = campusNow();
  const isToday = state.menu.date === now.date;
  const entries = [];
  for (const loc of state.menu.locations) {
    for (const meal of loc.meals) {
      const started = isToday && now.minutes >= toMinutes(meal.start);
      for (const item of meal.items) {
        entries.push({ dish_key: item.dish_key, location: loc.name, period: meal.period,
                       main: item.station_type === "main", started });
      }
    }
  }
  try {
    const [rows, mine] = await Promise.all([
      state.backend.getScores(state.menu.date, entries),
      state.backend.getMyVotes(state.menu.date),
    ]);
    state.scoreRows = rows;
    state.scores = indexScores(rows);
    state.myVotes = mine;
    freezeRanking();
  } catch (err) {
    console.error("Could not load ratings:", err); // menus still work without them
  }
}

// Take the snapshot that the list order is based on.
function freezeRanking() {
  state.rank = {
    scores: indexScores(state.scoreRows.map((r) => ({ ...r }))),
    taste: { ...state.taste },
    model: state.model,
  };
}

/* =====================================================================
   MEAL LOGIC
   ===================================================================== */
function mealStatus(meal, nowMinutes, isToday) {
  if (!meal) return { cls: "none", text: "Not serving", rank: 3 };
  if (!isToday) return { cls: "soon", text: `Opens ${prettyTime(meal.start)}`, rank: 1 };

  const start = toMinutes(meal.start), end = toMinutes(meal.end);
  if (nowMinutes >= start && nowMinutes < end) {
    return { cls: "open", text: `Open · until ${prettyTime(meal.end)}`, rank: 0 };
  }
  if (nowMinutes < start) {
    const wait = start - nowMinutes;
    return { cls: "soon", rank: 1,
             text: wait <= 60 ? `Opens in ${wait} min` : `Opens ${prettyTime(meal.start)}` };
  }
  return { cls: "closed", text: "Closed", rank: 2 };
}

function periodsInMenu(menu) {
  const earliest = {};
  for (const loc of menu.locations) {
    for (const meal of loc.meals) {
      const s = toMinutes(meal.start) ?? 9999;
      earliest[meal.period] = Math.min(earliest[meal.period] ?? 9999, s);
    }
  }
  return Object.keys(earliest).sort((a, b) => earliest[a] - earliest[b]);
}

function defaultPeriod(menu, nowMinutes, isToday) {
  const periods = periodsInMenu(menu);
  if (!isToday) return periods[0];
  for (const p of periods) {
    const stillComing = menu.locations.some((loc) => {
      const meal = loc.meals.find((m) => m.period === p);
      return meal && toMinutes(meal.end) > nowMinutes;
    });
    if (stillComing) return p;
  }
  return periods[periods.length - 1];
}

function hasMealsLeft(menu, nowMinutes) {
  return menu.locations.some((loc) => loc.meals.some((m) => toMinutes(m.end) > nowMinutes));
}

/* =====================================================================
   YOUR TURN
   Goals and your taste REORDER dishes. Filters HIDE dishes. Right now
   nothing is hidden. Build these yourself:

   Challenge 1: "High protein only" toggle
     - Add a button. Look at how renderGoals() draws buttons and how
       onClick() near the bottom reacts to them. Copy that pattern.
     - Remember whether it's on in state.filters, then call render().
     - Keep only dishes whose tags include "high_protein".
       Hint: items.filter((item) => item.tags.includes("high_protein"))

   Challenge 2: "Vegetarian" toggle (vegan dishes count too).

   Challenge 3: "Avoid an allergen" (e.g. no peanuts).
     Each dish has item.allergens, like ["milk", "egg"].

   Stuck? Open the browser console (Cmd+Option+J in Chrome).
   ===================================================================== */
function filterItems(items) {
  // const f = state.filters;
  return items;
}

/* =====================================================================
   VIEW MODEL
   Work out everything the screen needs BEFORE writing any HTML.
   ===================================================================== */
const ratedCount = () => Object.keys(state.taste).length;

function buildView() {
  const now = campusNow();
  const isToday = state.menu.date === now.date;
  const mealAt = (loc) => loc.meals.find((m) => m.period === state.period) || null;

  // One small tab per hall: is it open, and how do people rate it?
  const tabs = state.menu.locations.map((loc) => {
    const meal = mealAt(loc);
    return {
      name: loc.name,
      status: mealStatus(meal, now.minutes, isToday),
      rating: meal ? hallRating(state.scores, meal, loc.name, S) : null,
    };
  });
  // Your home hall first.
  tabs.sort((a, b) => (b.name === state.homeHall) - (a.name === state.homeHall));

  const loc = state.menu.locations.find((l) => l.name === state.hall) || null;
  if (!loc) return { now, isToday, tabs, loc: null };

  const rawMeal = mealAt(loc);
  const status = mealStatus(rawMeal, now.minutes, isToday);
  if (!rawMeal) return { now, isToday, tabs, loc, meal: null, status };

  const meal = { ...rawMeal, items: filterItems(rawMeal.items) };
  const hall = {
    loc, meal, status,
    rating: hallRating(state.scores, meal, loc.name, S),
    // Thumbs for today's meal until it ends (not only after the posted start time).
    canRate: isToday && now.minutes < toMinutes(meal.end),
  };

  const count = ratedCount();
  const frozenCount = Object.keys(state.rank.taste).length;
  const rows = meal.items.map((item) => {
    const liveBase = sortBase(state.scores, item, loc.name, meal.period, state.goal, S);
    const liveTaste = predict(state.model, state.taste, item);
    const frozenBase = sortBase(state.rank.scores, item, loc.name, meal.period, state.goal, S);
    const frozenTaste = predict(state.rank.model, state.rank.taste, item);
    return {
      item,
      base: liveBase,
      taste: liveTaste,
      live: blend(liveBase, liveTaste, count),
      order: blend(frozenBase, frozenTaste, frozenCount),
    };
  });

  const byOrder = (a, b) => b.order - a.order;
  const mains = rows.filter((r) => r.item.station_type === "main").sort(byOrder);
  const others = rows.filter((r) => r.item.station_type !== "main").sort(byOrder);

  return { now, isToday, tabs, loc, meal, status, hall, mains, others };
}

/** Eat well = ratings + your taste. Other goals nudge sort ~25% toward goal fit. */
function sortBase(index, item, location, period, goalKey, cfg) {
  const rated = dishRating(index, item, location, period, cfg).score;
  if (goalKey === "balanced") return rated;
  if (item.station_type !== "main") return rated;
  const fit = GOALS[goalKey].fit(item.nutrition, item);
  return 0.75 * rated + 0.25 * fit;
}

function todayVoteCounts(item, hall) {
  for (const r of state.scores.get(item.dish_key) || []) {
    if (r.is_today && r.location === hall.loc.name && r.period === hall.meal.period) {
      return { up: r.ups, down: r.downs };
    }
  }
  return { up: 0, down: 0 };
}

function publicRatingHTML(item, hall) {
  const d = dishRating(state.scores, item, hall.loc.name, hall.meal.period, S);
  const raw = todayVoteCounts(item, hall);
  const today = raw.up + raw.down;
  if (d.votes >= S.minVotesDish) {
    return `<span class="public-rating">${pct(d.score)}% liked · ${d.votes} rating${d.votes === 1 ? "" : "s"}</span>`;
  }
  if (today > 0) {
    return `<span class="public-rating early">👍 ${raw.up} · 👎 ${raw.down}</span>`;
  }
  return `<span class="public-rating none">No votes yet</span>`;
}

/* =====================================================================
   RENDERING: view model -> HTML
   ===================================================================== */

// Text from outside (dish names etc.) must be escaped before going into
// HTML, otherwise a name like "<b>" would be treated as code.
function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const pct = (score) => Math.round(score * 100);

const CHIP_LABELS = {
  high_protein: ["High protein", "protein"],
  vegan: ["Vegan", "veg"],
  vegetarian: ["Vegetarian", "veg"],
};
const DIET_LABELS = { halal: "Halal", kosher: "Kosher" };

function ratingLineHTML(hall) {
  const r = hall.rating;
  if (r.kind === "live") {
    return `<span class="score">${pct(r.score)}%</span> liked · <span class="live">Live</span> · ${r.votes} ratings`;
  }
  if (r.kind === "predicted") {
    return `<span class="score">${pct(r.score)}%</span> liked · predicted from ${r.votes} past ratings`;
  }
  if (!hall.canRate) {
    return state.menu && campusNow().date === state.menu.date
      ? "This meal has ended for today."
      : "No ratings yet";
  }
  return "Not enough ratings yet. Be one of the first.";
}

// "+ Add" button, or a  − 2 +  stepper once the dish is on the plate.
function addHTML(item, hall) {
  const key = Plate.entryKey(item.dish_key, hall.loc.name);
  const qty = Plate.qtyOf(state.plates, state.menu.date, hall.meal.period, key);
  const data = `data-dish="${esc(item.dish_key)}"`;
  if (!qty) {
    return `<button class="add" ${data} data-add="1" aria-label="Add ${esc(item.name)} to my plate">+ Add</button>`;
  }
  return `
    <div class="stepper" role="group" aria-label="Servings of ${esc(item.name)}">
      <button ${data} data-add="-1" aria-label="One less">−</button>
      <span>${qty}</span>
      <button ${data} data-add="1" aria-label="One more">+</button>
    </div>`;
}

function voteHTML(item, hall) {
  if (!hall.canRate) return "";
  const key = [item.dish_key, hall.loc.name, hall.meal.period].join("|");
  const mine = state.myVotes.get(key) || 0;
  const data = `data-dish="${esc(item.dish_key)}"`;
  return `
    <div class="vote">
      <button class="vote-btn up" ${data} data-vote="1" aria-pressed="${mine === 1}"
              aria-label="Thumbs up: ${esc(item.name)}">👍</button>
      <button class="vote-btn down" ${data} data-vote="-1" aria-pressed="${mine === -1}"
              aria-label="Thumbs down: ${esc(item.name)}">👎</button>
    </div>`;
}

function dishHTML(row, hall) {
  const { item, taste } = row;
  const n = item.nutrition;
  const meta = [];
  if (n.kcal != null) meta.push(`${Math.round(n.kcal)} cal`);
  if (n.protein_g != null) meta.push(`<b>${Math.round(n.protein_g)}g</b> protein`);
  if (n.serving) meta.push(esc(n.serving));

  const chips = [];
  if (taste.direct > 0) chips.push(`<span class="chip you">You liked this</span>`);
  else if (taste.direct === 0 && taste.p >= 0.68 && ratedCount() >= 3) chips.push(`<span class="chip you">Your taste</span>`);
  for (const tag of item.tags) {
    if (CHIP_LABELS[tag]) chips.push(`<span class="chip ${CHIP_LABELS[tag][1]}">${CHIP_LABELS[tag][0]}</span>`);
  }
  for (const diet of item.diets) {
    if (DIET_LABELS[diet]) chips.push(`<span class="chip">${DIET_LABELS[diet]}</span>`);
  }
  const allergens = item.allergens.length
    ? `<div class="allergens">Contains ${esc(item.allergens.join(", ").replace(/_/g, " "))}</div>` : "";

  return `
    <li class="dish">
      <div class="station">${esc(item.station)}</div>
      <div class="dish-name">${esc(item.name)}</div>
      <div class="meta">${meta.join(" · ")}</div>
      ${chips.length ? `<div class="chips">${chips.join("")}</div>` : ""}
      ${allergens}
      <div class="rating-row">${publicRatingHTML(item, hall)}</div>
      <div class="actions">${addHTML(item, hall)}${voteHTML(item, hall)}</div>
    </li>`;
}

// A "Show more" section that remembers whether it was open.
function detailsHTML(id, label, inner) {
  return `
    <details data-id="${esc(id)}" ${state.open.has(id) ? "open" : ""}>
      <summary>${label}</summary>
      <ul class="dishes">${inner}</ul>
    </details>`;
}

function hallHTML(view) {
  const { loc, meal, status, hall } = view;
  const notHome = loc.name !== state.homeHall
    ? `<button class="link" data-set-home="${esc(loc.name)}">Make ${esc(loc.name)} my default</button>` : "";

  if (!meal) {
    return `
      <section class="hall is-closed">
        <div class="hall-head"><h2 class="hall-name">${esc(loc.name)}</h2>
          <span class="status none">Not serving</span></div>
        <p class="empty">No ${esc(state.period.toLowerCase())} here today.</p>
        ${notHome}
      </section>`;
  }

  const preview = view.mains.slice(0, CONFIG.previewCount);
  const rest = view.mains.slice(CONFIG.previewCount);
  const row = (r) => dishHTML(r, hall);

  return `
    <section class="hall ${status.cls === "closed" ? "is-closed" : ""}">
      <div class="hall-head">
        <h2 class="hall-name">${esc(loc.name)}</h2>
        <span class="status ${status.cls}">${status.text}</span>
      </div>
      <div class="hours">${esc(meal.period)} · ${prettyTime(meal.start)}–${prettyTime(meal.end)}</div>
      <div class="rating-line">${ratingLineHTML(hall)}</div>
      ${notHome}

      ${view.mains.length ? `<ul class="dishes">${preview.map(row).join("")}</ul>`
                          : `<p class="empty">No matching dishes.</p>`}
      ${rest.length ? detailsHTML(loc.name + "|more", `Show ${rest.length} more mains`, rest.map(row).join("")) : ""}
      ${view.others.length ? detailsHTML(loc.name + "|others",
          `Salad bar, bars, drinks &amp; more (${view.others.length})`, view.others.map(row).join("")) : ""}
    </section>`;
}

// First visit: ask where they usually eat.
function pickHallHTML(view) {
  return `
    <section class="hall pick-hall">
      <h2 class="hall-name">Where do you usually eat?</h2>
      <p class="hours">You'll see this hall first. You can switch any time.</p>
      <div class="pick-list">
        ${view.tabs.map((t) => `
          <button data-set-home="${esc(t.name)}">
            <span>${esc(t.name)}</span>
            <span class="status ${t.status.cls}">${t.status.text}</span>
          </button>`).join("")}
      </div>
    </section>`;
}

function renderHallTabs(view) {
  $("halls-nav").hidden = !view.loc;
  $("halls-nav").innerHTML = view.tabs.map((t) => `
    <button class="pill hall-tab ${t.status.cls}" data-hall-tab="${esc(t.name)}"
            aria-pressed="${t.name === state.hall}">
      <span class="dot"></span>${esc(t.name)}${
        t.rating && t.rating.kind ? ` <span class="tab-score">${pct(t.rating.score)}%</span>` : ""}
    </button>`).join("");
}

function renderGoals() {
  $("goals").innerHTML = Object.entries(GOALS).map(([key, goal]) =>
    `<button class="pill" data-goal="${key}" aria-pressed="${key === state.goal}">${esc(goal.label)}</button>`
  ).join("");
}

function renderPeriods() {
  $("periods").innerHTML = periodsInMenu(state.menu).map((p) =>
    `<button class="pill" data-period-tab="${esc(p)}" aria-pressed="${p === state.period}">${esc(p)}</button>`
  ).join("");
}

/* ---------------------- meal calculator screens ---------------------- */
const round = (x) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);

// The bar pinned to the bottom of the screen.
function renderPlateBar() {
  const date = state.menu.date;
  const meal = Plate.mealEntries(state.plates, date, state.period);
  const day = Plate.dayEntries(state.plates, date);
  const bar = $("plate-bar");
  const tracking = day.length > 0 || Profile.goalsFor(state.profile).base || state.profile.customProtein;
  bar.hidden = !tracking;
  document.body.classList.toggle("has-plate", !!tracking);
  if (!tracking) return;

  // With goals set, the bar tracks the whole day against them.
  // Without goals, it shows the meal you're building.
  const goals = Profile.goalsFor(state.profile, state.boost);
  const hasGoals = goals.calories || goals.protein;
  const shown = hasGoals || !meal.length ? day : meal;
  const t = Plate.totals(shown);
  const n = Plate.servingsCount(shown);
  const cal = Math.round(t.kcal.total).toLocaleString(), protein = Math.round(t.protein_g.total);
  const title = hasGoals || !meal.length ? "Today" : esc(state.period) + " plate";
  const sum = hasGoals
    ? [goals.calories ? `${cal} of ${goals.calories.toLocaleString()} cal` : `${cal} cal`,
       goals.protein ? `${protein} of ${goals.protein}g protein` : `${protein}g protein`].join(" · ")
    : `${cal} cal · ${protein}g protein`;
  bar.innerHTML = `
    <button class="plate-open" data-sheet-open>
      <span class="plate-title">${n ? `${title} · ${n} serving${n === 1 ? "" : "s"}` : "Today's goals"}</span>
      <span class="plate-sum">${sum}</span>
      <span class="plate-go">View</span>
    </button>`;
}

function nutrientRowHTML(spec, t) {
  const { total, missing } = t[spec.key];
  const known = total > 0 || missing === 0;
  const value = known ? `${round(total)}${spec.unit}${missing ? "+" : ""}` : "—";
  const share = spec.dv && known ? Math.round((total / spec.dv) * 100) : null;
  return `
    <div class="nut-row">
      <span class="nut-label">${spec.label}</span>
      ${share === null ? `<span></span>`
        : `<span class="nut-bar"><span style="width:${Math.min(100, share)}%"></span></span>`}
      <span class="nut-value">${value}</span>
      <span class="nut-share">${share === null ? "" : share + "%"}</span>
    </div>`;
}

// The sheet that slides up: what's on the plate and what it adds up to.
function renderSheet() {
  const date = state.menu.date;
  const scope = state.sheet.scope;
  const entries = scope === "meal"
    ? Plate.mealEntries(state.plates, date, state.period)
    : Plate.dayEntries(state.plates, date);
  const t = Plate.totals(entries);
  const anyMissing = Plate.NUTRIENTS.some((s) => t[s.key].missing > 0);

  const list = entries.length ? entries.map((e) => `
    <li class="plate-item">
      <div class="plate-item-text">
        <div class="dish-name">${esc(e.name)}</div>
        <div class="meta">${scope === "day" ? esc(e.period) + " · " : ""}${esc(e.hall)}${
          e.serving ? " · " + esc(e.serving) + " each" : ""}</div>
      </div>
      <div class="stepper" role="group" aria-label="Servings of ${esc(e.name)}">
        <button data-plate-key="${esc(e.key)}" data-plate-period="${esc(e.period)}" data-add="-1" aria-label="One less">−</button>
        <span>${e.qty}</span>
        <button data-plate-key="${esc(e.key)}" data-plate-period="${esc(e.period)}" data-add="1" aria-label="One more">+</button>
      </div>
    </li>`).join("")
    : `<li class="empty">${scope === "meal"
        ? `Nothing on your ${esc(state.period.toLowerCase())} plate yet. Tap “+ Add” on any dish.`
        : "Nothing added today yet."}</li>`;

  const big = Plate.NUTRIENTS.filter((s) => s.group === "main").map((s) => `
    <div class="big-num">
      <div class="big-value">${Math.round(t[s.key].total)}${s.unit}</div>
      <div class="big-label">${s.label}</div>
    </div>`).join("");

  // Daily goals (set in Profile): how far along the whole day is.
  const goals = Profile.goalsFor(state.profile, state.boost);
  const dayTotals = Plate.totals(Plate.dayEntries(state.plates, date));
  const goalBar = (label, eaten, goal, unit) => (!goal ? "" : `
    <div class="goal">
      <div class="goal-top"><span>${label}</span>
        <span><b>${Math.round(eaten).toLocaleString()}${unit}</b> of ${goal.toLocaleString()}${unit}</span></div>
      <div class="goal-bar"><span style="width:${Math.min(100, Math.round((eaten / goal) * 100))}%"></span></div>
    </div>`);
  const goalBlock = goals.calories || goals.protein ? `
    <div class="goals">
      <div class="goals-head"><span>Today's goals</span>
        <button class="link" data-profile-open>Edit</button></div>
      ${goalBar("Calories", dayTotals.kcal.total, goals.calories, "")}
      ${goalBar("Protein", dayTotals.protein_g.total, goals.protein, "g")}
      ${goals.calories ? `
        <div class="seg small" role="group" aria-label="How active is today">
          ${Profile.BOOSTS.map((b) =>
            `<button data-boost="${b.value}" aria-pressed="${b.value === state.boost}">${b.label}</button>`).join("")}
        </div>` : ""}
    </div>` : `
    <button class="goals-empty" data-profile-open>
      <b>Set daily goals</b>
      <span>Calories and protein, suggested from a few details or your own numbers.</span>
    </button>`;

  const rows = (group) => Plate.NUTRIENTS.filter((s) => s.group === group)
    .map((s) => nutrientRowHTML(s, t)).join("");

  $("sheet-body").innerHTML = `
    <div class="sheet-head">
      <h2>My plate</h2>
      <button class="sheet-close" data-sheet-close aria-label="Close">✕</button>
    </div>
    <div class="seg" role="group" aria-label="What to add up">
      <button data-scope="meal" aria-pressed="${scope === "meal"}">${esc(state.period)}</button>
      <button data-scope="day" aria-pressed="${scope === "day"}">Whole day</button>
    </div>

    <ul class="plate-list">${list}</ul>

    <div class="big-nums">${big}</div>
    ${goalBlock}

    <div class="nut-head"><span>More detail</span><span>% of daily value</span></div>
    ${rows("more")}
    <div class="nut-head"><span>Vitamins &amp; minerals</span><span></span></div>
    ${rows("micro")}

    <p class="sheet-note">
      ${anyMissing ? "“+” or “—” means Berkeley Dining doesn't list that number for every dish, so the real total is higher. " : ""}
      Numbers are per listed serving; your actual portion may differ. Daily values are general
      adult guidelines, not personal advice.
    </p>
    ${scope === "meal" && entries.length
      ? `<button class="link danger" data-plate-clear>Clear ${esc(state.period.toLowerCase())} plate</button>` : ""}`;
}

function render() {
  const view = buildView();

  $("clock").textContent = `${prettyDate(view.now.date)} · ${prettyMinutes(view.now.minutes)}`;

  const notes = [];
  if (!view.isToday) notes.push(`Dining is closed for the night. Here's ${esc(prettyDate(state.menu.date))}'s menu.`);
  if (state.backend.mode === "demo") notes.push("Demo mode: the ratings shown are made-up sample data.");
  $("banner").innerHTML = notes.map((n) => `<p class="banner">${n}</p>`).join("");

  renderHallTabs(view);
  renderPeriods();

  if (!view.loc) {                       // first visit: choose a hall
    $("goal-wrap").hidden = true;
    $("hero").innerHTML = "";
    $("halls").innerHTML = pickHallHTML(view);
  } else {
    $("goal-wrap").hidden = !view.meal;
    renderGoals();
    $("hero").innerHTML = "";
    $("halls").innerHTML = hallHTML(view);
  }

  renderPlateBar();
  if (state.sheet.open) renderSheet();

  const updated = new Date(state.menu.scraped_at).toLocaleString("en-US", {
    timeZone: CONFIG.timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const ratingsNote = {
    shared: "Ratings are anonymous and shared by everyone using the app.",
    local: state.backend.problem
      ? "Couldn't reach the shared ratings, so your ratings are saved on this device for now."
      : "Your ratings are saved on this device only for now.",
    demo: "Ratings shown are sample data.",
  }[state.backend.mode];
  $("footer").innerHTML = `
    <p>Menus and nutrition from Berkeley Dining · updated ${esc(updated)}.</p>
    <p>Nutrition is per serving and can vary. If you have a serious allergy, confirm with dining staff.</p>
    <p>${ratingsNote} Rate the food, not the people who make it.</p>
    <p>Your taste and plate sync to your account when signed in. Suggestions are general, not medical advice.</p>`;
}

/* =====================================================================
   EVENTS: what happens when someone taps
   One listener on the whole page checks what was tapped ("event
   delegation"). That way buttons keep working after render() redraws them.
   ===================================================================== */
function save(key, value) {
  try { localStorage.setItem("campus-menus." + key, value); } catch { /* ignore */ }
}
function saved(key) {
  try { return localStorage.getItem("campus-menus." + key); } catch { return null; }
}

function syncUser() {
  if (!supabaseConfigured(CONFIG)) return;
  schedulePushUserData(CONFIG, packUserBlob(state, {
    goal: state.goal,
    hall: state.homeHall,
    boostDate: state.menu?.date,
  }));
}

function mirrorUserDataToLocal(blob) {
  if (!blob) return;
  if (blob.profile) Profile.saveProfile(blob.profile);
  if (blob.taste) {
    try { localStorage.setItem("campus-menus.taste", JSON.stringify(blob.taste)); } catch { /* ignore */ }
  }
  if (blob.plates && state.menu) Plate.savePlates(blob.plates, state.menu.date);
  if (blob.boostDate === state.menu?.date && typeof blob.boost === "number") {
    Profile.saveBoost(state.menu.date, blob.boost);
    state.boost = blob.boost;
  }
  if (blob.goal && GOALS[blob.goal]) {
    state.goal = blob.goal;
    save("goal", blob.goal);
  }
  if (blob.hall && state.menu?.locations.some((l) => l.name === blob.hall)) {
    state.homeHall = state.hall = blob.hall;
    save("hall", blob.hall);
  }
}

// Find a dish on the menu that's on screen right now.
function findItem(dishKey) {
  const loc = state.menu.locations.find((l) => l.name === state.hall);
  const meal = loc && loc.meals.find((m) => m.period === state.period);
  return (meal && meal.items.find((i) => i.dish_key === dishKey)) || null;
}

// Update the totals on screen straight away, without waiting for the server.
function applyVoteLocally(dish_key, hall, period, oldVote, newVote) {
  let row = state.scoreRows.find((r) => r.is_today && r.dish_key === dish_key &&
                                        r.location === hall && r.period === period);
  if (!row) {
    row = { dish_key, location: hall, period, is_today: true, ups: 0, downs: 0 };
    state.scoreRows.push(row);
  }
  if (oldVote === 1) row.ups = Math.max(0, row.ups - 1);
  if (oldVote === -1) row.downs = Math.max(0, row.downs - 1);
  if (newVote === 1) row.ups += 1;
  if (newVote === -1) row.downs += 1;
  state.scores = indexScores(state.scoreRows);
}

// A vote does two jobs: it counts toward everyone's rating of tonight's
// dish, AND it teaches the app what this person likes.
function setVote(item, hall, period, oldVote, newVote) {
  const key = [item.dish_key, hall, period].join("|");
  if (newVote) state.myVotes.set(key, newVote); else state.myVotes.delete(key);
  applyVoteLocally(item.dish_key, hall, period, oldVote, newVote);
  state.taste = recordTaste(state.taste, item, newVote, state.menu.date);
  state.model = trainFromVotes(state.taste);          // re-learn, takes a millisecond
  syncUser();
}

async function castVote(btn) {
  const item = findItem(btn.dataset.dish);
  if (!item) return;
  const hall = state.hall, period = state.period;
  const tapped = Number(btn.dataset.vote);
  const oldVote = state.myVotes.get([item.dish_key, hall, period].join("|")) || 0;
  const newVote = oldVote === tapped ? 0 : tapped;    // tapping again removes the vote

  // 1. Show it immediately ("optimistic update")
  setVote(item, hall, period, oldVote, newVote);
  render();

  // 2. Save it. If saving fails, put things back the way they were.
  try {
    await state.backend.vote({ date: state.menu.date, dish_key: item.dish_key,
                               location: hall, period, vote: newVote });
  } catch (err) {
    console.error("Could not save vote:", err);
    setVote(item, hall, period, newVote, oldVote);
    render();
  }
}

function changePlate(btn) {
  const change = Number(btn.dataset.add);
  const date = state.menu.date;
  if (btn.dataset.plateKey) {            // a stepper inside the sheet
    Plate.adjust(state.plates, date, btn.dataset.platePeriod, btn.dataset.plateKey, change);
  } else {                               // a button on the menu
    const item = findItem(btn.dataset.dish);
    if (!item) return;
    Plate.adjust(state.plates, date, state.period,
                 Plate.entryKey(item.dish_key, state.hall), change, item, state.hall);
  }
  Plate.savePlates(state.plates, campusNow().date);
  syncUser();
  render();
}

function openSheet() {
  state.sheet.open = true;
  renderSheet();
  if (!$("sheet").open) $("sheet").showModal();
}

function onClick(event) {
  if (event.target === $("sheet") || event.target === $("profile")) {   // tapped the dim backdrop
    event.target.close(); return;
  }
  const btn = event.target.closest("button");
  if (!btn) return;
  const d = btn.dataset;

  if (d.goal) {
    state.goal = d.goal; save("goal", state.goal);
    syncUser(); freezeRanking(); render();
  } else if (d.periodTab) {
    state.period = d.periodTab;
    freezeRanking(); render();
  } else if (d.hallTab) {
    state.hall = d.hallTab;
    freezeRanking(); render(); window.scrollTo(0, 0);
  } else if (d.setHome) {
    state.homeHall = state.hall = d.setHome; save("hall", state.homeHall);
    syncUser(); freezeRanking(); render(); window.scrollTo(0, 0);
  } else if (d.vote) {
    castVote(btn);
  } else if (d.add) {
    changePlate(btn);
  } else if ("sheetOpen" in d) {
    openSheet();
  } else if ("sheetClose" in d) {
    $("sheet").close();
  } else if (d.scope) {
    state.sheet.scope = d.scope; renderSheet();
  } else if ("profileOpen" in d) {
    openProfile();
  } else if ("profileClose" in d) {
    $("profile").close();
  } else if ("profileSave" in d) {
    state.profile = readProfileForm();
    Profile.saveProfile(state.profile);
    syncUser(); $("profile").close(); render();
  } else if ("profileClear" in d) {
    state.profile = Profile.clearProfile(); state.boost = 0;
    syncUser(); $("profile").close(); render();
  } else if (d.boost !== undefined) {
    state.boost = Number(d.boost);
    Profile.saveBoost(state.menu.date, state.boost);
    syncUser(); render();
  } else if ("plateClear" in d) {
    Plate.clearMeal(state.plates, state.menu.date, state.period);
    Plate.savePlates(state.plates, campusNow().date);
    syncUser(); render();
  } else if ("signOut" in d) {
    signOut(CONFIG);
  }
}

/* ------------------------- profile + goals ---------------------------- */
// Read the profile form into a tidy object (see Profile.clean).
function readProfileForm() {
  const f = new FormData($("profile-form"));
  const feet = Number(f.get("heightFt")) || 0, inches = Number(f.get("heightInch")) || 0;
  return Profile.clean({
    sex: f.get("sex"), weightLb: f.get("weightLb"), age: f.get("age"),
    heightIn: feet ? feet * 12 + inches : null,
    activity: f.get("activity"), aim: f.get("aim"),
    customCalories: f.get("customCalories"), customProtein: f.get("customProtein"),
  });
}

function suggestionHTML(profile) {
  const s = Profile.suggest(profile);
  if (!s.calories && !s.protein) {
    return "Add your weight for a protein suggestion. Add height and age too for calories.";
  }
  const parts = [];
  if (s.calories) parts.push(`<b>${s.calories.toLocaleString()} cal</b>`);
  if (s.protein) parts.push(`<b>${s.protein}g protein</b>`);
  return `Suggested for you: ${parts.join(" · ")} a day${
    s.calories ? "" : ". Add height and age for a calorie suggestion."}`;
}

// As they type, update the suggestion without redrawing the form
// (redrawing would kick the cursor out of the box they're typing in).
function onProfileInput() {
  const draft = readProfileForm();
  const s = Profile.suggest(draft);
  $("profile-suggest").innerHTML = suggestionHTML(draft);
  $("custom-calories").placeholder = s.calories ? String(s.calories) : "e.g. 2400";
  $("custom-protein").placeholder = s.protein ? String(s.protein) : "e.g. 120";
}

function renderProfile() {
  const p = state.profile;
  const s = Profile.suggest(p);
  const choice = (name, value, label, current) => `
    <label class="choice"><input type="radio" name="${name}" value="${value}"
      ${current === value ? "checked" : ""}><span>${label}</span></label>`;
  const feet = p.heightIn ? Math.floor(p.heightIn / 12) : "", inches = p.heightIn ? p.heightIn % 12 : "";

  $("profile-body").innerHTML = `
    <div class="sheet-head">
      <h2>Profile &amp; goals</h2>
      <button class="sheet-close" data-profile-close aria-label="Close">✕</button>
    </div>
    <p class="sheet-note">Optional. Used only to suggest daily goals, and kept on this phone.</p>

    <form id="profile-form" autocomplete="off">
      <div class="field">
        <span class="field-label">Sex (for the estimate)</span>
        <div class="choices">
          ${choice("sex", "male", "Male", p.sex)}${choice("sex", "female", "Female", p.sex)}${choice("sex", "", "Skip", p.sex)}
        </div>
      </div>

      <div class="field-row">
        <label class="field"><span class="field-label">Weight</span>
          <span class="with-unit"><input name="weightLb" type="number" inputmode="numeric" min="70" max="500" value="${p.weightLb ?? ""}"> lb</span></label>
        <label class="field"><span class="field-label">Age</span>
          <span class="with-unit"><input name="age" type="number" inputmode="numeric" min="16" max="90" value="${p.age ?? ""}"> yrs</span></label>
      </div>
      <div class="field">
        <span class="field-label">Height</span>
        <span class="with-unit">
          <input name="heightFt" type="number" inputmode="numeric" min="4" max="7" value="${feet}" aria-label="Height, feet"> ft
          <input name="heightInch" type="number" inputmode="numeric" min="0" max="11" value="${inches}" aria-label="Height, inches"> in
        </span>
      </div>

      <label class="field"><span class="field-label">A typical day</span>
        <select name="activity">
          ${Object.entries(Profile.ACTIVITY).map(([key, a]) =>
            `<option value="${key}" ${p.activity === key ? "selected" : ""}>${a.label}</option>`).join("")}
        </select></label>

      <div class="field">
        <span class="field-label">I want to</span>
        <div class="choices">
          ${Object.entries(Profile.AIMS).map(([key, a]) => choice("aim", key, a.label, p.aim)).join("")}
        </div>
      </div>

      <p class="suggest" id="profile-suggest">${suggestionHTML(p)}</p>

      <div class="field-label">Or set your own (leave blank to use the suggestion)</div>
      <div class="field-row">
        <label class="field"><span class="field-label">Calories a day</span>
          <input id="custom-calories" name="customCalories" type="number" inputmode="numeric"
                 min="${Profile.LIMITS.calories[0]}" max="${Profile.LIMITS.calories[1]}" step="50"
                 placeholder="${s.calories || "e.g. 2400"}" value="${p.customCalories ?? ""}"></label>
        <label class="field"><span class="field-label">Protein a day (g)</span>
          <input id="custom-protein" name="customProtein" type="number" inputmode="numeric"
                 min="${Profile.LIMITS.protein[0]}" max="${Profile.LIMITS.protein[1]}" step="5"
                 placeholder="${s.protein || "e.g. 120"}" value="${p.customProtein ?? ""}"></label>
      </div>

      <button type="button" class="primary" data-profile-save>Save</button>
      <button type="button" class="link danger" data-profile-clear>Clear my profile and goals</button>
      ${CONFIG.auth?.required ? '<button type="button" class="link" data-sign-out>Sign out</button>' : ""}
    </form>

    <p class="sheet-note">
      Suggestions are rough estimates from a standard equation, not medical or personal advice.
      Goals are a guide, not a test: some days you'll be over and some under, and that's normal.
      If tracking numbers starts to feel stressful, clear your goals. Everything else works without them.
    </p>`;
}

function openProfile() {
  renderProfile();
  if (!$("profile").open) $("profile").showModal();
}

// Remember which "Show more" sections are open so a redraw doesn't close them.
function onToggle(event) {
  const id = event.target.dataset && event.target.dataset.id;
  if (!id) return;
  if (event.target.open) state.open.add(id); else state.open.delete(id);
}

/* =====================================================================
   INIT: runs once when the page loads
   ===================================================================== */
async function init() {
  const demo = new URLSearchParams(location.search).has("demo");
  if (!demo) {
    const session = await ensureLoggedIn(CONFIG);
    if (CONFIG.auth?.required && !session) return;
  }

  const now = campusNow();
  let menu = await loadMenu(now.date);

  // After the last meal of the day, show tomorrow instead.
  if (!menu || !hasMealsLeft(menu, now.minutes)) {
    const tomorrow = await loadMenu(addDays(now.date, 1));
    if (tomorrow && tomorrow.locations.length) menu = tomorrow;
  }
  if (!menu) {
    $("halls").innerHTML = `<p class="empty">No menus found. Dining may be closed (breaks or
      holidays), or the scraper hasn't run yet.</p>`;
    return;
  }

  state.menu = menu;
  state.period = defaultPeriod(menu, now.minutes, menu.date === now.date);
  if (GOALS[saved("goal")]) state.goal = saved("goal");
  if (menu.locations.some((l) => l.name === saved("hall"))) {
    state.homeHall = state.hall = saved("hall");
  }
  state.taste = loadTaste();
  state.model = trainFromVotes(state.taste);
  state.plates = Plate.loadPlates();
  state.profile = Profile.loadProfile();
  state.boost = Profile.loadBoost(menu.date);

  if (!demo && supabaseConfigured(CONFIG)) {
    await pullUserData(CONFIG, state, mirrorUserDataToLocal);
    state.model = trainFromVotes(state.taste);
    if (GOALS[saved("goal")]) state.goal = saved("goal");
    if (menu.locations.some((l) => l.name === saved("hall"))) {
      state.homeHall = state.hall = saved("hall");
    }
  }
  freezeRanking();

  document.addEventListener("click", onClick);
  $("profile").addEventListener("input", onProfileInput);
  document.addEventListener("toggle", onToggle, true);
  $("sheet").addEventListener("close", () => { state.sheet.open = false; });

  // Show menus right away; ratings arrive a moment later.
  state.backend = { mode: "local" };
  render();
  state.backend = await createBackend(CONFIG);
  await loadRatings();
  render();

  setInterval(render, 60 * 1000);                                        // keep Open/Closed fresh
  setInterval(async () => { await loadRatings(); render(); }, 3 * 60 * 1000); // keep scores fresh
}

init();
