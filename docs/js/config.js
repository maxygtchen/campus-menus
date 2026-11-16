/* =====================================================================
   CONFIG: every setting in one place
   ===================================================================== */
export const CONFIG = {
  school: "berkeley",
  dataBase: "data/berkeley/",        // menus live next to the page (same site)
  timezone: "America/Los_Angeles",   // always use campus time
  previewCount: 6,                   // mains shown before "Show more"

  /* ---- Ratings database (Supabase) --------------------------------
     Leave these empty and ratings are saved on this device only.
     Fill them in (see SETUP-RATINGS.md) and ratings are shared by
     everyone. The "publishable" / "anon" key is designed to be public,
     so it's fine in this file. NEVER put the "secret" / "service_role"
     key here. */
  supabaseUrl: "",
  supabaseKey: "",

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
