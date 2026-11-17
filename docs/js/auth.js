/* =====================================================================
   AUTH: Supabase sign-in shared by login.html and the main app
   ===================================================================== */
import { CONFIG } from "./config.js";

let clientPromise = null;

export function supabaseConfigured(config = CONFIG) {
  const url = (config.supabaseUrl || "").trim();
  const key = (config.supabaseKey || "").trim();
  if (!url || !key) return false;
  if (url.includes("YOUR-PROJECT") || key.includes("...")) return false;
  return true;
}

export async function getClient(config = CONFIG) {
  if (!supabaseConfigured(config)) return null;
  if (!clientPromise) {
    clientPromise = import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm")
      .then(({ createClient }) => createClient(config.supabaseUrl, config.supabaseKey));
  }
  return clientPromise;
}

export async function getSession(config = CONFIG) {
  const sb = await getClient(config);
  if (!sb) return null;
  const { data: { session } } = await sb.auth.getSession();
  return session;
}

export function emailAllowed(email, config = CONFIG) {
  const domains = config.auth?.emailDomains || [];
  if (!domains.length) return true;
  const at = (email || "").trim().toLowerCase().lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domains.some((d) => domain === d.toLowerCase());
}

export function loginUrl(nextPath) {
  const next = encodeURIComponent(nextPath || "index.html");
  return `login.html?next=${next}`;
}

/** Redirect to login if auth is required and there is no session. */
export async function ensureLoggedIn(config = CONFIG) {
  if (!config.auth?.required) return await getSession(config);
  if (!supabaseConfigured(config)) {
    console.warn("auth.required is on but Supabase is not configured.");
    return null;
  }
  const session = await getSession(config);
  if (session) return session;
  const next = location.pathname.split("/").pop() || "index.html";
  const q = location.search ? location.search : "";
  location.replace(loginUrl(next + q));
  return null;
}

export async function signOut(config = CONFIG) {
  const sb = await getClient(config);
  if (sb) await sb.auth.signOut();
  clientPromise = null;
  location.replace(loginUrl());
}