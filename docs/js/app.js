/* =====================================================================
   APP: ties everything together

   Read in this order:
     time helpers   "what time is it at Berkeley right now?"
     data loading   fetch the JSON your scraper saved
     meal logic     open / opens soon / closed
     YOUR TURN      filters you'll build
     view model     work out everything the screen needs to show
     rendering      turn that into HTML
     events         what happens when someone taps
     init           runs once when the page loads

   Other files:
     config.js    settings            scoring.js   ratings + goal maths
     backend.js   where votes are stored
   ===================================================================== */
import { CONFIG } from "./config.js";
import { createBackend } from "./backend.js";
import { GOALS, indexScores, dishRating, hallRating, goalScore, hallFit } from "./scoring.js";

const S = CONFIG.scoring;
const $ = (id) => document.getElementById(id);

const state = {
  menu: null,            // the day's JSON
  period: null,          // selected meal tab, e.g. "Dinner"
  goal: "balanced",      // selected goal (a key of GOALS)
  filters: {},           // for YOUR TURN
  backend: null,         // where votes are stored
  scoreRows: [],         // rating totals from the backend
  scores: new Map(),     // the same totals, indexed by dish (updates as you vote)
  rankScores: new Map(), // a snapshot used for ORDERING, so the list doesn't
                         // jump around under your thumb the moment you vote
  myVotes: new Map(),    // "dish|hall|meal" -> 1 or -1
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

// Ask the backend for rating totals and this person's own votes.
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
    state.rankScores = indexScores(rows.map((r) => ({ ...r })));
    state.myVotes = mine;
  } catch (err) {
    console.error("Could not load ratings:", err); // menus still work without them
  }
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
   Goals (above the cards) REORDER dishes. Filters HIDE dishes. Right now
   nothing is hidden. Build these yourself:

   Challenge 1: "High protein only" toggle
     - Add a button. Look at how renderGoals() draws buttons and how
       onClick() at the bottom reacts to them. Copy that pattern.
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
   Work out everything the screen needs BEFORE writing any HTML:
   each hall's status, score and best picks, in display order.
   ===================================================================== */
function buildView() {
  const now = campusNow();
  const isToday = state.menu.date === now.date;

  const halls = state.menu.locations.map((loc) => {
    const meal = loc.meals.find((m) => m.period === state.period) || null;
    const status = mealStatus(meal, now.minutes, isToday);
    if (!meal) return { loc, meal, status, fit: { fit: 0, picks: [] }, order: 0, rating: null, canRate: false };

    const visible = { ...meal, items: filterItems(meal.items) };
    const fit = hallFit(state.rankScores, visible, loc.name, state.goal, S);
    // A hall people like more gets a small boost in the ordering.
    const liked = hallRating(state.rankScores, visible, loc.name, S).score;
    return {
      loc, meal: visible, status, fit,
      order: fit.fit * (0.5 + 0.5 * liked),
      rating: hallRating(state.scores, visible, loc.name, S),
      // You can rate a dish once its meal has started today.
      canRate: isToday && now.minutes >= toMinutes(meal.start),
    };
  });

  // Open halls first, then opening soon, then closed; best fit first within each.
  halls.sort((a, b) => a.status.rank - b.status.rank || b.order - a.order);

  // The recommendation: best hall that is open (or about to be).
  const best = halls.find((h) => h.meal && h.status.rank <= 1 && h.fit.picks.length) || null;
  return { now, isToday, halls, best };
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
  if (r && r.kind === "live") {
    return `<span class="score">${pct(r.score)}%</span> liked · <span class="live">Live</span> · ${r.votes} ratings`;
  }
  if (r && r.kind === "predicted") {
    return `<span class="score">${pct(r.score)}%</span> liked · predicted from ${r.votes} past ratings`;
  }
  return hall.canRate ? "Not enough ratings yet. Be one of the first." : "No ratings yet";
}

function voteHTML(item, hall) {
  if (!hall.canRate) return "";
  const key = [item.dish_key, hall.loc.name, hall.meal.period].join("|");
  const mine = state.myVotes.get(key) || 0;
  const d = dishRating(state.scores, item, hall.loc.name, hall.meal.period, S);
  const data = `data-dish="${esc(item.dish_key)}" data-hall="${esc(hall.loc.name)}" data-period="${esc(hall.meal.period)}"`;
  return `
    <div class="vote">
      <div class="vote-btns">
        <button class="vote-btn up" ${data} data-vote="1" aria-pressed="${mine === 1}"
                aria-label="Thumbs up: ${esc(item.name)}">👍</button>
        <button class="vote-btn down" ${data} data-vote="-1" aria-pressed="${mine === -1}"
                aria-label="Thumbs down: ${esc(item.name)}">👎</button>
      </div>
      ${d.votes >= S.minVotesDish ? `<div class="vote-pct">${pct(d.score)}% liked</div>` : ""}
    </div>`;
}

function dishHTML(item, hall) {
  const n = item.nutrition;
  const meta = [];
  if (n.kcal != null) meta.push(`${Math.round(n.kcal)} cal`);
  if (n.protein_g != null) meta.push(`<b>${Math.round(n.protein_g)}g</b> protein`);
  if (n.serving) meta.push(esc(n.serving));

  const chips = [];
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
      <div class="dish-info">
        <div class="station">${esc(item.station)}</div>
        <div class="dish-name">${esc(item.name)}</div>
        <div class="meta">${meta.join(" · ")}</div>
        ${chips.length ? `<div class="chips">${chips.join("")}</div>` : ""}
        ${allergens}
      </div>
      ${voteHTML(item, hall)}
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

function hallHTML(hall) {
  const { loc, meal, status } = hall;
  if (!meal) {
    return `
      <section class="hall is-closed">
        <div class="hall-head"><h2 class="hall-name">${esc(loc.name)}</h2>
          <span class="status none">Not serving</span></div>
        <p class="empty">No ${esc(state.period.toLowerCase())} here today.</p>
      </section>`;
  }

  // Mains that fit the goal float to the top. Nothing is hidden.
  const fitOf = (item) => goalScore(state.rankScores, item, loc.name, meal.period, state.goal, S);
  const mains = meal.items.filter((i) => i.station_type === "main")
    .map((item) => ({ item, fit: fitOf(item) }))
    .sort((a, b) => b.fit - a.fit)
    .map((x) => x.item);
  const others = meal.items.filter((i) => i.station_type !== "main");
  const preview = mains.slice(0, CONFIG.previewCount);
  const rest = mains.slice(CONFIG.previewCount);
  const row = (item) => dishHTML(item, hall);

  return `
    <section class="hall ${status.cls === "closed" ? "is-closed" : ""}">
      <div class="hall-head">
        <h2 class="hall-name">${esc(loc.name)}</h2>
        <span class="status ${status.cls}">${status.text}</span>
      </div>
      <div class="hours">${esc(meal.period)} · ${prettyTime(meal.start)}–${prettyTime(meal.end)}</div>
      <div class="rating-line">${ratingLineHTML(hall)}</div>

      ${mains.length ? `<ul class="dishes">${preview.map(row).join("")}</ul>`
                     : `<p class="empty">No matching dishes.</p>`}
      ${rest.length ? detailsHTML(loc.name + "|more", `Show ${rest.length} more mains`, rest.map(row).join("")) : ""}
      ${others.length ? detailsHTML(loc.name + "|others",
          `Sides, salad bar &amp; desserts (${others.length})`, others.map(row).join("")) : ""}
    </section>`;
}

function heroHTML(view) {
  const hall = view.best;
  if (!hall) return "";
  const meal = state.period.toLowerCase();
  const title = !view.isToday ? `Best for ${meal} tomorrow`
              : hall.status.rank === 0 ? "Best right now" : `Best for ${meal}`;

  const picks = hall.fit.picks.map(({ item }) => {
    const n = item.nutrition;
    const d = dishRating(state.scores, item, hall.loc.name, hall.meal.period, S);
    const liked = d.votes >= S.minVotesDish ? ` · ${pct(d.score)}% liked` : "";
    return `
      <li>
        <span class="pick-name">${esc(item.name)}</span>
        <span class="pick-meta">${Math.round(n.protein_g)}g protein · ${Math.round(n.kcal)} cal${liked}</span>
      </li>`;
  }).join("");

  return `
    <section class="hero" aria-label="Recommendation">
      <div class="hero-kicker">${esc(title)} · ${esc(GOALS[state.goal].label)}</div>
      <div class="hall-head">
        <h2 class="hero-hall">${esc(hall.loc.name)}</h2>
        <span class="status ${hall.status.cls}">${hall.status.text}</span>
      </div>
      <div class="hero-why">${esc(hall.fit.reason)}${
        hall.rating.kind ? ` · ${pct(hall.rating.score)}% liked` : ""}</div>
      <ol class="picks">${picks}</ol>
    </section>`;
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

function render() {
  const view = buildView();

  $("clock").textContent = `${prettyDate(view.now.date)} · ${prettyMinutes(view.now.minutes)}`;

  const notes = [];
  if (!view.isToday) notes.push(`Dining is closed for the night. Here's ${esc(prettyDate(state.menu.date))}'s menu.`);
  if (state.backend.mode === "demo") notes.push("Demo mode: the ratings shown are made-up sample data.");
  $("banner").innerHTML = notes.map((n) => `<p class="banner">${n}</p>`).join("");

  renderGoals();
  renderPeriods();
  $("hero").innerHTML = heroHTML(view);
  $("halls").innerHTML = view.halls.map(hallHTML).join("") ||
    `<p class="empty">No menus posted for this day.</p>`;

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
    <p>Picks are general suggestions, not personal nutrition advice.</p>`;
}

/* =====================================================================
   EVENTS: what happens when someone taps
   One listener on the whole page checks what was tapped ("event
   delegation"). That way buttons keep working after render() redraws them.
   ===================================================================== */
function saveGoal(goal) {
  try { localStorage.setItem("campus-menus.goal", goal); } catch { /* ignore */ }
}
function savedGoal() {
  try { return localStorage.getItem("campus-menus.goal"); } catch { return null; }
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

async function castVote(btn) {
  const { dish, hall, period } = btn.dataset;
  const tapped = Number(btn.dataset.vote);
  const key = [dish, hall, period].join("|");
  const oldVote = state.myVotes.get(key) || 0;
  const newVote = oldVote === tapped ? 0 : tapped;   // tapping again removes the vote

  // 1. Show it immediately ("optimistic update")
  if (newVote) state.myVotes.set(key, newVote); else state.myVotes.delete(key);
  applyVoteLocally(dish, hall, period, oldVote, newVote);
  render();

  // 2. Save it. If saving fails, put things back the way they were.
  try {
    await state.backend.vote({ date: state.menu.date, dish_key: dish, location: hall, period, vote: newVote });
  } catch (err) {
    console.error("Could not save vote:", err);
    if (oldVote) state.myVotes.set(key, oldVote); else state.myVotes.delete(key);
    applyVoteLocally(dish, hall, period, newVote, oldVote);
    render();
  }
}

function onClick(event) {
  const btn = event.target.closest("button");
  if (!btn) return;
  if (btn.dataset.goal) {
    state.goal = btn.dataset.goal;
    saveGoal(state.goal);
    render();
  } else if (btn.dataset.periodTab) {
    state.period = btn.dataset.periodTab;
    render();
  } else if (btn.dataset.vote) {
    castVote(btn);
  }
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
  if (GOALS[savedGoal()]) state.goal = savedGoal();

  document.addEventListener("click", onClick);
  document.addEventListener("toggle", onToggle, true);

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
