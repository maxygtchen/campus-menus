# Accounts and sign-in

Sign-in uses the **same Supabase project** as shared ratings. Personal data
(profile, taste, plate, goals) is stored in the `user_data` table. Dish
ratings still use the `ratings` table, tied to the signed-in user id.

## 1. Database

In Supabase **SQL Editor**, run `supabase/schema-user-data.sql` (after
`schema.sql`). You should see table **user_data**.

## 2. Email sign-up

1. **Authentication → Providers → Email** — enable email sign-up.
2. For a quick campus launch, you can turn **off** “Confirm email” so
   students can sign in immediately after creating an account.
3. In `docs/js/config.js`, `auth.emailDomains` controls who can register:
   - `["berkeley.edu"]` — only `@berkeley.edu`
   - `[]` — any email

## 3. Google sign-in (optional)

You use **two websites**. They do different jobs:

| Website | URL | Your job |
|--------|-----|----------|
| **Google Cloud** | console.cloud.google.com | Create an OAuth client; Google gives you a Client ID + secret |
| **Supabase** | supabase.com/dashboard | Paste that ID + secret; tell Supabase which app URLs are allowed |

**Do not mix these up**

- In **Google**, you paste **one** URL: Supabase’s callback  
  `https://maarpzlnxrwtliwqgjlp.supabase.co/auth/v1/callback`
- In **Supabase**, you paste **your menu app** URLs (`localhost`, GitHub Pages)
- You never put `github.io` or `localhost` into Google’s redirect list for this setup

**Skip Google entirely:** set `google: false` in `docs/js/config.js` and use email
sign-up only (sections 1–2 are enough).

---

### Part A — Google Cloud (create the OAuth client)

All of this happens at [console.cloud.google.com](https://console.cloud.google.com)
while signed into your Google account.

#### A1. Pick a Google Cloud project

1. Open the console. Top bar: click the **project name** (might say “Select a project”).
2. **New project** → name it `campus-menus` → **Create**.
3. Wait a few seconds, then select that project from the same dropdown.

*(The “Project ID” Google shows here is only for Google — not your Supabase
project, and not something you paste into the app.)*

#### A2. OAuth consent screen (one-time)

1. Left **hamburger menu** (☰) → **APIs & Services** → **OAuth consent screen**.
2. **User type** → choose **External** → **Create**.
3. **App name:** `Campus Menus` (anything). **User support email:** your email.
4. **Developer contact email:** your email → **Save and continue**.
5. **Scopes** → **Save and continue** (defaults are fine).
6. **Test users** → **Add users** → your Gmail → **Save and continue**.
7. **Back to Dashboard**.

While the app is in **Testing**, only those test users can sign in with Google.

#### A3. Create the OAuth client

1. Left menu → **APIs & Services** → **Credentials**.
2. Top: **+ Create credentials** → **OAuth client ID**.
3. If it asks for a consent screen first, you missed A2; go back and finish it.
4. **Application type:** **Web application**.
5. **Name:** `Supabase campus-menus` (anything).
6. **Authorized JavaScript origins** — leave **empty** (not needed).
7. **Authorized redirect URIs** → **+ Add URI** → paste exactly:

   ```
   https://maarpzlnxrwtliwqgjlp.supabase.co/auth/v1/callback
   ```

8. **Create**.
9. A popup shows **Your Client ID** and **Your Client secret**. Copy both
   (or open them later from the client name in the Credentials list).
   Keep the secret private — paste it only into Supabase, not GitHub or chat.

You are **done with Google** until you add more test users or publish the app.

---

### Part B — Supabase (connect Google to your project)

All of this is in [supabase.com/dashboard](https://supabase.com/dashboard) →
your **campus-menus** project.

#### B1. Turn on the Google provider

1. Left sidebar → **Authentication** (key icon).
2. Click **Sign In / Providers** (or **Providers** under Configuration).
3. Find **Google** in the list → expand or click it.
4. Toggle **Enable** (or **Google enabled**) **on**.
5. **Client ID (for OAuth):** paste the Client ID from Google (long `.apps.googleusercontent.com` string).
6. **Client secret (for OAuth):** paste the secret from Google.
7. **Save**.

Supabase may show a **Callback URL** on this screen — it should match the URI
you put in Google (`…/auth/v1/callback`). You do not paste that into Google
again if you already did in A3.

#### B2. Allow your app’s pages after login

1. Still under **Authentication**, open **URL Configuration** (sibling of Providers).
2. **Site URL** — for testing you can set:
   `http://localhost:8000/index.html`
   (For production, switch to your GitHub Pages `index.html`.)
3. **Redirect URLs** — click **Add URL** for **each** line below (four total):

   ```
   http://localhost:8000/index.html
   http://localhost:8000/login.html
   https://maxygtchen.github.io/campus-menus/index.html
   https://maxygtchen.github.io/campus-menus/login.html
   ```

4. **Save**.

After a successful Google sign-in, Supabase sends the user back to one of these
pages (usually `index.html`).

---

### Part C — Test Google login

```bash
cd docs && python3 -m http.server 8000
```

1. Open **http://localhost:8000** → login page.
2. Click **Continue with Google**.
3. Pick your Google account (must be a **test user** from A2 while in Testing).
4. You should land on the menu, signed in.

**If something fails**

| What you see | Likely fix |
|--------------|------------|
| `redirect_uri_mismatch` | Google A3 URI must be exactly the Supabase `…/auth/v1/callback` URL |
| Google “Access blocked” / app not verified | Add your Gmail under OAuth consent screen → **Test users** |
| Back to login, no session | Add localhost `index.html` and `login.html` in Supabase B2 |
| Button does nothing | Supabase B1 — Google enabled, ID and secret saved |

---

## 4. App settings

In `docs/js/config.js`:

```js
auth: {
  required: true,              // false = old behavior (no login gate)
  emailDomains: ["berkeley.edu"],
  google: true,
},
```

## 5. Test locally

```bash
cd docs && python3 -m http.server 8000
```

1. Open http://localhost:8000 — you should land on **login.html**.
2. Create an account or use Google.
3. After sign-in, set profile / plate; check **Table Editor → user_data**.

## 6. Anonymous sign-in

With `auth.required: true`, the app no longer uses anonymous auth. You can
leave anonymous **disabled** in Supabase so only real accounts can rate.

Demo mode still works with **`?demo=1`** (no login).

## School-only email vs Google

- **Email/password** — client checks `emailDomains` on create account.
- **Google** — Google does not enforce `@berkeley.edu`; for strict campus
  only access, disable Google or add a Supabase **Auth Hook** later to reject
  non-school domains.