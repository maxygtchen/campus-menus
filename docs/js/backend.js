/* =====================================================================
   BACKEND: where ratings are stored
   The rest of the app doesn't care WHERE votes live. It only calls:

     backend.getScores(date, entries)  -> totals for the dishes on the menu
     backend.getMyVotes(date)          -> what this person voted today
     backend.vote({...})               -> save, change or remove a vote

   Three interchangeable versions provide those same three functions:
     local   votes saved in this browser only (works with zero setup)
     shared  votes saved in Supabase, shared by everyone
     demo    made-up sample ratings, to preview the design (?demo=1)

   Swapping the storage without touching the rest of the app is a
   pattern you'll see everywhere in software.
   ===================================================================== */

const STORE_KEY = "campus-menus.votes";
const voteKey = (v) => [v.dish_key, v.location, v.period].join("|");

/* ---------------------------- local ---------------------------------- */
function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch { return {}; }           // private windows can block storage
}
function writeStore(store) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* ignore */ }
}

function localBackend() {
  // store looks like { "2026-11-16": { "dish|hall|meal": 1, ... }, ... }
  return {
    mode: "local",
    async getScores(date) {
      const rows = [];
      for (const [day, votes] of Object.entries(readStore())) {
        if (day > date) continue;
        for (const [key, vote] of Object.entries(votes)) {
          const [dish_key, location, period] = key.split("|");
          rows.push({ dish_key, location, period, is_today: day === date,
                      ups: vote === 1 ? 1 : 0, downs: vote === -1 ? 1 : 0 });
        }
      }
      return rows;
    },
    async getMyVotes(date) {
      return new Map(Object.entries(readStore()[date] || {}));
    },
    async vote(v) {
      const store = readStore();
      store[v.date] = store[v.date] || {};
      if (v.vote === 0) delete store[v.date][voteKey(v)];
      else store[v.date][voteKey(v)] = v.vote;
      writeStore(store);
    },
  };
}

/* ---------------------------- shared --------------------------------- */
async function sharedBackend(config) {
  // Load the Supabase library only when it's needed.
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  const sb = createClient(config.supabaseUrl, config.supabaseKey);

  // Anonymous sign-in: no email or password, but each device gets its
  // own user id, which is how "one vote per person" is enforced.
  let { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) throw error;
    session = data.session;
  }
  const userId = session.user.id;
  const school = config.school;

  return {
    mode: "shared",
    async getScores(date, entries) {
      const keys = [...new Set(entries.map((e) => e.dish_key))];
      const { data, error } = await sb.rpc("get_scores",
        { p_school: school, p_date: date, p_dish_keys: keys });
      if (error) throw error;
      return data;
    },
    async getMyVotes(date) {
      const { data, error } = await sb.from("ratings")
        .select("dish_key, location, period, vote")
        .eq("school", school).eq("served_on", date);
      if (error) throw error;
      return new Map(data.map((row) => [voteKey(row), row.vote]));
    },
    async vote(v) {
      const where = { user_id: userId, school, dish_key: v.dish_key,
                      location: v.location, period: v.period, served_on: v.date };
      const { error } = v.vote === 0
        ? await sb.from("ratings").delete().match(where)
        : await sb.from("ratings").upsert({ ...where, vote: v.vote },
            { onConflict: "user_id,school,dish_key,location,period,served_on" });
      if (error) throw error;
    },
  };
}

/* ----------------------------- demo ---------------------------------- */
// Turns any text into a repeatable number between 0 and 1, so the sample
// ratings are the same every time you load the page.
function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13;
  return ((h >>> 0) % 10000) / 10000;
}

function demoBackend() {
  const mine = localBackend();
  return {
    ...mine,
    mode: "demo",
    async getScores(date, entries) {
      const rows = await mine.getScores(date);
      for (const e of entries) {
        const quality = Math.min(0.97, Math.max(0.3,
          0.45 + 0.5 * seeded("q" + e.dish_key) + 0.16 * (seeded("h" + e.location) - 0.5)));
        const past = Math.round(seeded("p" + e.dish_key + e.location) * (e.main ? 14 : 3));
        if (past) rows.push({ dish_key: e.dish_key, location: e.location, period: e.period,
          is_today: false, ups: Math.round(past * quality), downs: past - Math.round(past * quality) });
        const now = e.started ? Math.round(seeded("t" + date + e.dish_key + e.location) * (e.main ? 6 : 1)) : 0;
        if (now) rows.push({ dish_key: e.dish_key, location: e.location, period: e.period,
          is_today: true, ups: Math.round(now * quality), downs: now - Math.round(now * quality) });
      }
      return rows;
    },
  };
}

/* --------------------------- choose one ------------------------------ */
export async function createBackend(config) {
  if (new URLSearchParams(location.search).has("demo")) return demoBackend();
  if (config.supabaseUrl && config.supabaseKey) {
    try {
      return await sharedBackend(config);
    } catch (err) {
      console.error("Shared ratings unavailable, saving on this device instead:", err);
      return { ...localBackend(), problem: true };
    }
  }
  return localBackend();
}
