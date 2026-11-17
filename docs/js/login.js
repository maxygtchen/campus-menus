import { CONFIG } from "./config.js";
import { getClient, getSession, emailAllowed, supabaseConfigured } from "./auth.js";

const params = new URLSearchParams(location.search);
const next = params.get("next") || "index.html";
let mode = "in"; // "in" | "up" | "forgot"

const $ = (id) => document.getElementById(id);

function setMode(nextMode) {
  mode = nextMode;
  const signIn = mode === "in";
  const signUp = mode === "up";
  const forgot = mode === "forgot";

  $("tab-in").setAttribute("aria-selected", signIn ? "true" : "false");
  $("tab-up").setAttribute("aria-selected", signUp ? "true" : "false");
  $("tab-in").hidden = forgot;
  $("tab-up").hidden = forgot;
  $("tab-in").parentElement.hidden = forgot;

  $("password-wrap").hidden = forgot;
  $("password").required = !forgot;
  $("password").autocomplete = signUp ? "new-password" : "current-password";

  $("forgot-row").hidden = !signIn;
  $("back-to-signin").hidden = !forgot;

  const showGoogle = !forgot && CONFIG.auth?.google !== false;
  $("google").hidden = !showGoogle;
  $("or-divider").hidden = !showGoogle;
  if (showGoogle) $("or-divider").removeAttribute("aria-hidden");
  else $("or-divider").setAttribute("aria-hidden", "true");

  if (forgot) {
    $("submit").textContent = "Send reset link";
    $("sub").textContent = "Enter your email and we’ll send a link to choose a new password.";
  } else {
    $("submit").textContent = signIn ? "Sign in" : "Create account";
    $("sub").textContent = "Sign in to sync your goals, plate, and what you like.";
  }

  showError("");
  showOk("");
}

function redirectAfterLogin() {
  location.replace(next);
}

function showError(msg) {
  $("err").textContent = msg || "";
}

function showOk(msg) {
  $("ok").textContent = msg || "";
}

function domainHint() {
  const domains = CONFIG.auth?.emailDomains || [];
  if (!domains.length) return "Any email address works for this campus.";
  const list = domains.map((d) => "@" + d).join(" or ");
  return `Use your school email (${list}).`;
}

function resetRedirectUrl() {
  return new URL("reset.html", location.href).href;
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

  if (params.get("mode") === "forgot") setMode("forgot");
  else setMode("in");

  $("tab-in").addEventListener("click", () => setMode("in"));
  $("tab-up").addEventListener("click", () => setMode("up"));
  $("forgot").addEventListener("click", () => setMode("forgot"));
  $("back-to-signin").addEventListener("click", () => setMode("in"));

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    showOk("");
    const email = $("email").value.trim();
    const password = $("password").value;
    if (!emailAllowed(email, CONFIG)) {
      const domains = (CONFIG.auth?.emailDomains || []).join(", ");
      showError(`Please use a school email ending in ${domains}.`);
      return;
    }
    const sb = await getClient(CONFIG);

    if (mode === "forgot") {
      const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: resetRedirectUrl(),
      });
      if (error) {
        showError(error.message);
        return;
      }
      showOk("Check your email for a password reset link. It may take a minute to arrive.");
      return;
    }

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
    showOk("");
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
