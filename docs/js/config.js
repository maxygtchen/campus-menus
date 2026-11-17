/* =====================================================================
   CONFIG: every setting in one place
   ===================================================================== */
import { SCHOOLS, getSchool, allEmailDomains } from "./schools.js";

const STORAGE_SCHOOL = "campus-menus.school";

function savedSchoolId() {
  try {
    const id = localStorage.getItem(STORAGE_SCHOOL);
    if (id && SCHOOLS[id]) return id;
  } catch { /* ignore */ }
  return "berkeley";
}

const school = getSchool(savedSchoolId());

export const CONFIG = {
  school: school.id,
  dataBase: school.dataBase,
  timezone: school.timezone,
  sourceLabel: school.sourceLabel,
  previewCount: 6,                   // mains shown before "Show more"

  /* ---- Ratings database (Supabase) --------------------------------
     Leave these empty and ratings are saved on this device only.
     Fill them in from the Supabase dashboard (SETUP-RATINGS.md) —
     use your real project ref, not the YOUR-PROJECT placeholder.
     Then ratings are shared by
     everyone. The "publishable" / "anon" key is designed to be public,
     so it's fine in this file. NEVER put the "secret" / "service_role"
     key here. */
  supabaseUrl: "https://maarpzlnxrwtliwqgjlp.supabase.co",
  supabaseKey: "sb_publishable_s2wBIj1YTDpoYQpS4J4FtQ_lbIIsw-q",

  /* ---- Accounts (Supabase Auth) -------------------------------------
     require: must sign in before the menu loads (see SETUP-AUTH.md).
     emailDomains: empty = any email; list = school emails only.
     google: show "Continue with Google" (enable provider in Supabase). */
  auth: {
    required: true,
    // Accept any supported UC campus email so students can switch schools.
    emailDomains: allEmailDomains(),
    google: true,
  },

  /* ---- How scores are calculated (see scoring.js) ------------------ */
  scoring: {
    prior: 0.7,          // with no votes, assume 70% of people like a dish
    priorWeight: 4,      // ...and treat that assumption like 4 votes
    todayWeight: 3,      // a vote from this meal counts 3x a past vote
    otherHallWeight: 0.5,// a past vote for the same dish at another hall counts half
    minVotesDish: 3,     // don't show a dish % until it has this many votes
    minVotesHall: 8,     // don't show a hall score until it has this many
    liveVotes: 5,        // this many votes from the current meal = "Live"
  },
};

/** Persist a school choice and reload so menus / ratings key off it. */
export function setSchool(id) {
  if (!SCHOOLS[id]) return;
  try { localStorage.setItem(STORAGE_SCHOOL, id); } catch { /* ignore */ }
  // Clear hall default when switching campuses — halls don't carry over.
  try { localStorage.removeItem("campus-menus.hall"); } catch { /* ignore */ }
  location.reload();
}
