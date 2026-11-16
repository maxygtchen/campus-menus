# Turning on shared ratings

Out of the box, ratings are saved on each person's own device. To make them
shared (everyone sees the same scores), connect a free Supabase database.
About 15 minutes. Menu names in Supabase's dashboard change now and then, so
a label may differ slightly from what's written here.

## 1. Create the project

1. Sign up at supabase.com and create a **new project** on the free plan.
2. Pick a region on the US west coast (closest to Berkeley).
3. It asks for a database password. Save it in your password manager.
   You won't need it for this app.

## 2. Create the table

1. In the project, open **SQL Editor** and start a new query.
2. Paste the whole contents of `supabase/schema.sql` and press **Run**.
3. Open **Table Editor**. You should see an empty `ratings` table.

## 3. Allow anonymous sign-ins

Open **Authentication**, find the sign-in settings (Sign In / Providers),
and turn on **Allow anonymous sign-ins**.

This gives every phone its own invisible account, with no email or password.
That's what makes "one vote per person per dish per meal" enforceable.

## 4. Connect the app

1. In the project, find the **Project URL** and the **publishable key**
   (the **Connect** button, or Project Settings > API Keys). On older
   projects the key is called **anon public**.
2. Paste both into `docs/js/config.js`:

   ```js
   supabaseUrl: "https://abcdefgh.supabase.co",
   supabaseKey: "sb_publishable_...",
   ```

That key is meant to be public, so committing it is fine. The **secret /
service_role** key is the opposite: it bypasses every security rule. Never
put it in this repo or anywhere in the website.

## 5. Test, then ship

```bash
cd docs && python3 -m http.server 8000
```

Open http://localhost:8000 during a meal, tap a thumbs up, then look at
**Table Editor > ratings** in Supabase. Your vote should be there as a row.
The page footer should say ratings are "shared by everyone". If it says
it couldn't reach the shared ratings, open the browser console for the error.

Then `git add . && git commit -m "Connect shared ratings" && git push`.

## Good to know

- **Free projects pause** after about a week with no activity. If ratings
  stop working over winter break, un-pause the project in the dashboard.
- **Before a big launch**, turn on CAPTCHA protection for sign-ins
  (Authentication settings) so a script can't create thousands of fake voters.
- **To preview the design with sample ratings**, add `?demo=1` to the URL.
  Handy for screenshots, and clearly labelled as sample data.
- **How scores are calculated** is explained in `docs/js/scoring.js`, and
  the numbers you can tune are in `docs/js/config.js`.
