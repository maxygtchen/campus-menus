import { CONFIG } from "./config.js";
import { getClient, getSession, emailAllowed, supabaseConfigured } from "./auth.js";

const params = new URLSearchParams(location.search);
const next = params.get("next") || "index.html";
let mode = "in";

const $ = (id) => document.getElementById(id);

function setMode(nextMode) {
  mode = nextMode;
  const signIn = mode === "in";
  $("tab-in").setAttribute("aria-selected", signIn ? "true" : "false");
  $("tab-up").setAttribute("aria-selected", signIn ? "false" : "true");
  $("submit").textContent = signIn ? "Sign in" : "Create account";
  $("password").autocomplete = signIn ? "current-password" : "new-password";
}

function redirectAfterLogin() {
  location.replace(next);
}

function showError(msg) {
  $("err").textContent = msg || "";
}

function domainHint() {
  const domains = CONFIG.auth?.emailDomains || [];
  if (!domains.length) return "Any email address works for this campus.";
  const list = domains.map((d) => "@" + d).join(" or ");
  return `Use your school email (${list}).`;
}

async function init() {
  if (!supabaseConfigured(CONFIG)) {
    showError("Supabase is not configured yet. Ask the site owner to finish setup.");
    return;
  }
  $("domain-hint").textContent = domainHint();
  if (CONFIG.auth?.google !== false) {
    $("google").hidden = false;
    $("or-divider").hidden = false;
    $("or-divider").removeAttribute("aria-hidden");
  }

  const session = await getSession(CONFIG);
  if (session) {
    redirectAfterLogin();
    return;
  }

  $("tab-in").addEventListener("click", () => setMode("in"));
  $("tab-up").addEventListener("click", () => setMode("up"));

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    const email = $("email").value.trim();
    const password = $("password").value;
    if (!emailAllowed(email, CONFIG)) {
      const domains = (CONFIG.auth?.emailDomains || []).join(", ");
      showError(`Please use a school email ending in ${domains}.`);
      return;
    }
    const sb = await getClient(CONFIG);
    const res = mode === "in"
      ? await sb.auth.signInWithPassword({ email, password })
      : await sb.auth.signUp({ email, password });
    if (res.error) {
      showError(res.error.message);
      return;
    }
    if (mode === "up" && !res.data.session) {
      showError("Check your email to confirm your account, then sign in.");
      setMode("in");
      return;
    }
    redirectAfterLogin();
  });

  $("google").addEventListener("click", async () => {
    showError("");
    const sb = await getClient(CONFIG);
    const redirectTo = new URL(next, location.href).href;
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) showError(error.message);
  });
}

init();