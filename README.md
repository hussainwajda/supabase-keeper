# Supabase Keeper

One dashboard for every Supabase project across all your accounts:

- **"Which account owns this?"** Paste a project URL, ref, dashboard link, connection string, or a whole `.env` into the search box. It shows the owning account email and how you log into it (GitHub / Google / email).
- **Free-slot tracker:** see how many of each account's 2 free projects are used, and which account to use for the next one.
- **Keep-alive:** a daily Vercel Cron pings every project you opt in, on that project's own interval (default 5 days), so free projects never hit the 7-day inactivity pause. Every ping is logged, and failures (including "project paused") show up on the dashboard.

## Setup (≈10 min)

1. **Registry DB:** pick one Supabase project to hold the registry (it can be one of your existing hobby projects; the tables won't clash). Run `supabase/schema.sql` in its SQL editor. The daily cron queries this DB, so the registry itself stays active.
2. **In each project you want kept alive**, run `supabase/keep_alive.sql`. It creates a tiny read-only `keep_alive` table, so each ping is a real Postgres query and not just an API-gateway hit. The SQL can also be copied from the project form.
3. **Env vars** (see `.env.example`):
   ```
   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   # registry project
   APP_PASSWORD                               # your dashboard password
   SESSION_SECRET, CRON_SECRET                # openssl rand -hex 32
   ```
4. **Deploy to Vercel:** `vercel deploy --prod` (or import the repo), then add the env vars. `vercel.json` registers the cron (`0 6 * * *`, daily at 06:00 UTC). Vercel automatically sends `Authorization: Bearer $CRON_SECRET`.
5. Log in, add your accounts, then add projects.

## How the keep-alive works

- The cron runs **daily** (the Vercel Hobby limit is once per day). Each run pings only the projects that are *due* (`now - last_pinged_at >= interval_days`), so each project gets its own interval.
- A ping is `GET https://<ref>.supabase.co/rest/v1/keep_alive?select=*&limit=1` with the project's **anon/publishable key**. If you leave the ping table blank, it hits `/auth/v1/health` instead, which is weaker.
- The app refuses service_role / `sb_secret_` keys, and keys are never sent to the browser.
- Manual triggers: the **Ping** / **Ping all now** buttons, or
  `curl -H "Authorization: Bearer $CRON_SECRET" "https://<app>/api/cron/keep-alive?force=1"`

## Local dev

```
cp .env.example .env.local   # fill in
npm install && npm run dev
```
