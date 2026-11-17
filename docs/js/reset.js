import { CONFIG } from "./config.js";
import { getClient, getSession, supabaseConfigured } from "./auth.js";

const $ = (id) => document.getElementById(id);

function showError(msg) {
  $("err").textContent = msg || "";
}
function showOk(msg) {
  $("ok").textContent = msg || "";
}

async function waitForRecoverySession(sb, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const { data: { session } } = await sb.auth.getSession();
    if (session) return session;
    // Supabase puts recovery tokens in the URL hash; give the client a moment.
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function init() {
  if (!supabaseConfigured(CONFIG)) {
    showError("Supabase is not configured yet. Ask the site owner to finish setup.");
    $("form").hidden = true;
    return;
  }

  const sb = await getClient(CONFIG);
  const session = (await getSession(CONFIG)) || (await waitForRecoverySession(sb));
  if (!session) {
    showError("This reset link is invalid or has expired. Request a new one from the sign-in page.");
    $("form").hidden = true;
    $("sub").textContent = "We couldn’t verify your reset link.";
    return;
  }

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    showOk("");
    const password = $("password").value;
    const password2 = $("password2").value;
    if (password.length < 8) {
      showError("Use at least 8 characters.");
      return;
    }
    if (password !== password2) {
      showError("Passwords don’t match.");
      return;
    }
    const { error } = await sb.auth.updateUser({ password });
    if (error) {
      showError(error.message);
      return;
    }
    showOk("Password updated. Taking you to the menus…");
    $("submit").disabled = true;
    setTimeout(() => location.replace("index.html"), 900);
  });
}

init();
