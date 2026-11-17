/* =====================================================================
   USER SYNC: profile, taste, plates, and prefs in Supabase user_data
   ===================================================================== */
import { getClient, supabaseConfigured } from "./auth.js";

let pushTimer = null;

export function packUserBlob(state, extras = {}) {
  return {
    v: 1,
    profile: state.profile,
    taste: state.taste,
    plates: state.plates,
    boost: state.boost,
    goal: extras.goal ?? null,
    hall: extras.hall ?? null,
    boostDate: extras.boostDate ?? null,
  };
}

function applyBlob(state, blob, onApply) {
  if (!blob || typeof blob !== "object") return;
  if (blob.profile) state.profile = blob.profile;
  if (blob.taste) state.taste = blob.taste;
  if (blob.plates) state.plates = blob.plates;
  if (typeof blob.boost === "number") state.boost = blob.boost;
  onApply?.(blob);
}

/** Download cloud copy into state (and optional localStorage mirrors). */
export async function pullUserData(config, state, onApply) {
  if (!supabaseConfigured(config)) return;
  const sb = await getClient(config);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;

  const { data, error } = await sb.from("user_data")
    .select("data")
    .eq("user_id", user.id)
    .eq("school", config.school)
    .maybeSingle();
  if (error) {
    console.warn("Could not load your saved data:", error.message);
    return;
  }
  if (data?.data) applyBlob(state, data.data, onApply);
}

export async function pushUserDataNow(config, blob) {
  if (!supabaseConfigured(config)) return;
  const sb = await getClient(config);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;

  const row = {
    user_id: user.id,
    school: config.school,
    data: blob,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("user_data").upsert(row, { onConflict: "user_id" });
  if (error) console.warn("Could not save your data:", error.message);
}

/** Debounced save (~1.2s after the last change). */
export function schedulePushUserData(config, blob) {
  if (!supabaseConfigured(config)) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushUserDataNow(config, blob), 1200);
}