# Keepstack roadmap

Ten phases. Each one ends at a state you can run, test by hand, and push — so the repo gets a
meaningful commit per phase and `main` is never broken in between.

Every phase lists **what it changes**, **how you verify it**, and **what it must not break**. The
last item matters most: your real accounts and projects have to survive all ten.

**Status legend:** ☐ not started · ◐ in progress · ☑ done

---

## ☑ Phase 0 — Rename, re-skin, and the adapter seam

The groundwork. No new features, no new providers, no auth changes — so if something breaks here,
it's obvious.

- Rename to `keepstack` (package, metadata, brand, README), add MIT `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`
- Tailwind v4 + shadcn/ui, porting the current 127 lines of CSS to tokens that keep the existing dark/light behaviour (`/ui-ux-pro-max` drives this)
- `lib/providers/` with `types.ts`, `registry.ts`, and `supabase.ts` wrapping *today's* ping logic unchanged; `lib/ref.ts` → `supabase.parse()`
- `lib/registry/` replaces `lib/db.ts` with typed accessors
- Migration `0002`: provider enum, `provider` default `'supabase'`, `external_id` backfilled from `ref`, `metadata`/`lifecycle`/`strategy` columns
- **Export JSON** button — a safety net that exists before any risky migration

**Verify:** dashboard, search, project form, ping, ping-all and the cron all behave exactly as
before, with every real row intact. Diff an export taken before and after: identical.
**Must not break:** anything. This phase is a refactor.

**Verified 2026-10-17** against the live registry (7 accounts, 5 projects): all routes 200,
export excludes secrets, and a real sweep pinged 3 Supabase projects through the new adapter
(1 ok, 2 pre-existing `keep_alive`-table failures, unchanged from before). Two fixes came out
of testing: reads and writes are now schema-aware so the app works *before* migration 0002 is
applied (with a banner saying what to run), and system-preference dark mode was restored after
the Tailwind migration briefly made the theme class-only.

---

## ☑ Phase 1 — Supabase Auth with Google, and multi-user

Where it stops being a single-password personal tool.

- `@supabase/ssr`; Google OAuth + email/password; `/auth/callback`, `/auth/confirm`; middleware swapped off `APP_PASSWORD`
- `profiles` table and trigger; `user_id` on accounts and projects; **RLS on every table**
- Migration `0004` — the one-time claim flow: banner, service-role write, `audit_log` entry, then `KEEPSTACK_ALLOW_LEGACY_CLAIM` comes out of Vercel
- Account menu, sign-out, empty states for a brand-new user

**Verify:** sign in with Google, claim the legacy rows, see all your real data. Sign in as a second
account in a private window — it sees *nothing* of yours. Try reading another user's row directly
through the anon client; RLS refuses.
**Must not break:** the cron, which moves to a per-user loop under the service role.

**Built and verified 2026-10-17, with one gap.** Verified locally: the setup gate (every route
redirects to `/setup` until the registry env is complete), the auth gate (every private route
redirects to `/login` preserving `?next=`), the login page renders Google + email/password, the
cron still runs under the service role (401 without `CRON_SECRET`, and a forced sweep produced
the same 3 results as Phase 0), and the `42703` probe the claim banner relies on returns exactly
what the code expects.

**Not yet verified, and it needs you:** actual sign-in, the claim flow, and RLS enforcement. All
three need the registry's **anon key**, which isn't in `.env` and can't be derived from the
service-role key. Migration `0003` also has to be run by hand. Steps are in the README and on
the `/setup` page.

Phase 1 also added two things not in the original plan, both from testing:
a **`/setup` page** so a fresh clone gets an actionable screen instead of a stack trace on every
request, and `currentUser()` returning null rather than throwing when the env is incomplete —
without it the root layout crashed the setup page it was supposed to be showing.

---

## ☑ Phase 2 — The vault

Requirements 3 and 4. Deliberately before the new providers, because every provider after this
stores credentials and they should land encrypted from day one.

- `lib/crypto/`: AES-256-GCM, scrypt KDF, envelope wrap/unwrap, DEK sealing, boot-time env assertions
- Migration `0005`: `secrets`, `vault_sessions`, `otp_challenges`; **`projects.anon_key` migrated out of plaintext** into an encrypted `server`-tier secret, old column dropped
- PIN set/change/reset; email OTP via Resend; 10-minute sudo sessions; lockout after 5 attempts
- Reveal UI: masked field, auto-re-mask at 30 s, copy-and-clear at 60 s
- Vault page: secret inventory, active sessions, audit log
- Per-user **"No recovery"** switch (drops `dek_srv`)
- `/security-review` on the whole phase before it merges

**Verify:** set a PIN; store an account login password; reveal it with the PIN; reveal it with an
OTP; get locked out after 5 bad PINs; confirm the audit log shows all of it. Then check the
database directly — `select * from secrets` is unreadable ciphertext, and the old plaintext
`anon_key` column is gone.
**Must not break:** the keep-alive sweep, which now decrypts `server`-tier keys instead of reading
a plaintext column.

**Built and verified 2026-10-17, with one gap.** `lib/crypto/` ships with **26 unit tests, all
passing** (`pnpm test`) covering round-trips, wrong keys, tampered tags and ciphertext, malformed
input, IV uniqueness across 2000 seals, PIN/salt/user binding, and both cross-tier attack
directions. The sweep was re-run against the live registry and gave the same 3 results as
Phase 1, now reading keys through the vault with a fallback to the legacy column.

**Not yet verified, and it needs you:** PIN setup, unlock, reveal, lockout, OTP, and the key
migration. Those need migration `0005` plus a signed-in user, and sign-in still needs the anon
key. The code degrades deliberately in the meantime: `/vault` shows a "run 0005" notice instead
of crashing, and the credential panels stay hidden.

Beyond the plan, this phase added:
- **`0006_drop_plaintext_keys.sql`**, which refuses to run while any plaintext key remains, and
  also retires the Supabase-only `ref` and `ping_table` columns that 0002 replaced.
- **A defensive `bytea` → `text` conversion in `0005`.** `0003` had already been run against the
  live database with `bytea` vault columns before the envelope format was settled, so `0005`
  migrates them rather than leaving a broken schema.
- **A `vaultSchemaReady()` guard** on all four pages that read secrets — the Phase 0 lesson about
  code running ahead of hand-run SQL, applied preemptively this time.

One regression was caught and fixed during testing: Phase 1's setup gate short-circuited *before*
the public-path check, so `/api/cron/sweep` was redirected to `/setup` whenever the anon key was
absent. The keep-alive would have silently stopped on a half-configured deployment while the app
otherwise looked fine. Cron paths are now exempt from the config gate, since they authenticate
with their own secret and use the service role.

---

## ☑ Phase 3 — Supabase, properly

Everything the Management API makes possible. This phase alone is a bigger upgrade than the rename.

- Account-level **scoped PAT**, stored `server`-tier, verified on save
- **Auto-discovery:** `GET /v1/projects` → import or reconcile projects, with a diff view before writing
- Real status: `INACTIVE` surfaces as a **paused** banner with a **Restore** button (`POST /v1/projects/{ref}/restore`)
- Anon keys fetched automatically via `/api-keys` — no more pasting
- Ping upgraded to `POST /v1/projects/{ref}/database/query` (`select 1`, `read_only`), falling back to REST-on-table then auth health; the `keep_alive` table becomes optional and the SQL snippet stays for PAT-less users
- Health panel (`?services=db,auth,rest`), real free-slot counts from `/v1/organizations/{slug}/projects`
- **Database password** capture at project creation, `personal` tier, plus a connection-string builder that assembles `DATABASE_URL` / `DIRECT_URL` after an unlock

**Verify:** add your PAT, watch your real projects import with correct status, restore a paused
project from Keepstack, confirm a ping logs as a SQL query, and build a working Prisma pair of URLs
from a stored password.
**Must not break:** projects with no PAT — they keep using the anon-key path.

**Built and verified 2026-10-17, except the PAT itself.** 25 adapter unit tests cover parsing
(bare ref, API URL, dashboard URL, pooler connection string, whole `.env`), the `INACTIVE → paused`
status mapping, credential validation, tier assignment, and connection-string assembly including
percent-encoding. Every Management API path was then exercised live against a deliberately invalid
token: `discover` and `status` surface the useful 401, `fetchProjectCredentials` and `health`
degrade to `{}`/`[]` rather than throwing, and — the one that matters — **a bad PAT falls through
to the anon-key path instead of reporting a false failure**. The sweep was re-run against the live
registry and gave identical results to Phase 2.

**Not verified:** anything needing a real `sbp_` token — discovery against your accounts, SQL
pings, automatic key fetch, restore. Create a scoped PAT and add it under an account's
**Credentials**.

Design decisions worth recording:
- **Sync is plan-then-apply.** A preview lists what will be imported, re-homed or updated, and
  the apply step **re-plans server-side** rather than trusting the posted plan — the browser
  round-trip is long enough for a project to be created or paused at the provider.
- **A sync never deletes.** A project that vanished from the provider is reported, not removed:
  "deleted" and "the token lost access to that organization" look identical from here, and only
  one of them is safe to act on.
- **Imported projects arrive with keep-alive off**, so an import never silently starts sending
  traffic to someone's project.
- **The pooler host is never guessed.** `aws-0-<region>.pooler.supabase.com` has changed before,
  so with no known host the builder returns the direct URL only. A correct absence beats a
  plausible wrong answer.

---

## ☑ Phase 4 — Neon (the `watch` provider)

Second provider, chosen deliberately to be the one that proves pinging isn't the whole product.

- Adapter: API key auth, `GET /projects`, branches, endpoints, `/users/me/organizations`
- `GET /consumption_history/v2/projects` → `usage_snapshots`; CU-seconds ÷ 3600
- Quota cards: CU-hours used / 100, storage, transfer, **days of headroom at current burn** — read limits from the API rather than hardcoding (sources disagree on 0.5 vs 1 GB)
- No interval picker. The UI explains scale-to-zero instead, and offers **Suspend endpoint** — the anti-ping
- `/dataviz` informs the usage charts; the same component must later serve Upstash and Atlas

**Verify:** add a Neon API key, see real projects and a real CU-hour chart, confirm no ping is ever
sent, and confirm the UI never offers one.
**Must not break:** the dashboard's mixed-provider view, which now has to render two different
project card shapes.

**Built and verified 2026-10-17, except with a real key.** 19 adapter unit tests, the most
important of which assert the negative: `capabilities.ping === false` **and** `ping === undefined`,
so a regression can't quietly start spending someone's compute budget. Headroom projection is
tested including its null cases (no limit, nothing used, a point-in-time metric with no period).
Live-checked against an invalid key: every path returns an actionable message naming the
credential rather than a stack trace.

The sweep now routes by strategy — `ping` on an interval, `watch` daily, `alert_only` as a status
check — and its response counts the three separately, because "pinged 3" and "watched 3" are
different claims and only one of them reset an inactivity clock.

**One real bug fixed on the way.** Migration 0006 had dropped `ref`, `ping_table` and `anon_key`,
but `saveProject` still wrote all three — editing any project would have failed with a
`42703 undefined_column`. `forWrite` now detects and strips dropped columns the way it already
handled columns that don't exist *yet*, `ping_table` moved into `metadata`, and the drift is
covered in both directions.

**And an accessibility bug found by measuring rather than eyeballing.** Running the dataviz
skill's contrast check on the status tokens showed light-mode `--warning` at **2.96:1** and
`--success` at **3.25:1** on white — both failing WCAG for the 12-13px text they were already
being used for, since Phase 0. Re-solved for the lowest lightness clearing 4.5:1 at the same hue
and chroma: all four status inks now pass as text in both modes. Fills keep their vividness by
using the same tokens at low opacity.

---

## ☑ Phase 5 — MongoDB Atlas

The hardest adapter: OAuth, a real driver, and a genuine security trade-off to present well.

- Service-account OAuth (`POST /api/oauth/token`, 1-hour Bearer) — **not** Digest API keys
- Pinned `Accept: application/vnd.atlas.<date>+json`, with a clear error on 406
- Discovery: `/orgs` → `/orgs/{id}/groups` → `/groups/{id}/clusters`; status from **`paused`**, not `stateName`
- Driver ping: dynamic `import("mongodb")`, Node runtime, short `serverSelectionTimeoutMS`, connection closed every time
- Setup wizard that is honest about `0.0.0.0/0`: what it means, why it's needed from Vercel, and the dedicated read-only `keepstack-ping` user that limits the damage
- Graceful degradation to `alert_only` with no SRV string stored — still reads `paused`, still warns
- M0 limits on the project card (0.5 GB, 500 conns, 100 ops/s, 10 GB/7 d)

**Verify:** add a service account, import a real M0 cluster, ping it with the driver, and confirm a
paused cluster is detected correctly. Then remove the SRV string and confirm it degrades to
alerting instead of erroring.
**Must not break:** the 60-second cron budget — a hanging driver connection is the obvious way to
blow it, hence the timeouts.

**Built and verified 2026-10-17, except with a real Atlas account.** 29 adapter unit tests, plus
live checks of the OAuth and driver paths: an invalid service account produces an actionable
message (including that Atlas secrets expire, which is the failure people hit months later), a
missing connection string degrades to `alert_only`, and the driver fails inside its 8-second
timeout rather than hanging.

Three decisions the research forced:

- **Service accounts, not programmatic API keys.** The legacy keys need HTTP **Digest** auth,
  which `fetch` does not implement — supporting them would mean hand-rolling an MD5
  challenge/response inside a credential path. OAuth client-credentials is one POST, and tokens
  are cached per client id for their hour.
- **`paused`, never `stateName`.** A paused cluster can still report `stateName: "IDLE"`, so
  branching on the state name would miss the one condition this provider exists to catch.
- **The API is versioned per resource.** Pinned at `2025-03-12` (what the current docs use) with
  a fallback walk through older dates on a 406, because an endpoint we touch may not have been
  revised as recently. Probing unauthenticated was useless — Atlas returns 401 before it checks
  the version.

**Two bugs caught in testing:**

1. **A DNS failure was being reported as a pause.** Inferring `paused` from any socket error
   would put a red paused banner on a project whose only problem is a typo in the host or a
   firewall rule. Now the Admin API's `paused` field is the only thing that may set that, and
   the adapter makes one extra call on the failure path to get a real answer instead of a
   plausible one. Covered by a test.
2. **The sweep would have blown the cron budget.** It ran sequentially, which was fine while
   every provider answered over HTTP in under a second — but a driver connection to a paused
   cluster sits for its full 8 seconds, and seven in a row exceed 60. The sweep now groups by
   provider with **bounded concurrency and a per-provider deadline** (Atlas capped at 2 in
   flight, HTTP providers at 6), and anything it runs out of time for is logged as skipped and
   retried next run rather than silently dropped.

The `0.0.0.0/0` trade-off gets its own panel on the project page rather than a help string: what
it actually means, the dedicated read-only `keepstack-ping` user that limits the damage, the
fixed-IP alternative, and the explicit option to decline and keep alerts-only. M0's hard limits
(0.5 GB, 500 connections, 100 ops/sec, 10 GB per 7 days) are listed as facts, not meters —
Atlas publishes no per-cluster usage for free tiers, and invented numbers would be worse than
none.

---

## ☐ Phase 6 — Upstash

The cheapest ping and a clean API. Good phase to land after the hard one.

- Basic auth `email:api_key`; `GET /v2/redis/databases` discovery; `state`, `type`, region, limits
- **Confirm against a live account** whether `GET /v2/redis/database/{id}` returns `rest_token` and `password` when `credentials` isn't hidden — the published schema omits them. Fall back to pasting the REST token once
- Ping: `GET https://{endpoint}/ping` with the REST token
- Pessimistic **14-day** archive clock (the FAQ says 14 *or* 30 with no dates), 7-day default interval, usage against 500K commands/month
- Loud warnings: archived → console-only recovery; a `/start-redis` database → deleted in 3 days
- Setup note: Vercel/Fly-created accounts have no Developer API

**Verify:** add your Upstash key, import a real database, ping it, see the command count move.
**Must not break:** nothing structural — by now the adapter seam should make this routine. If it
isn't routine, the seam is wrong and this is where that shows.

---

## ☐ Phase 7 — Appwrite Cloud

The `alert_only` provider. Its value is warning you before data is destroyed.

- Per-project registration with a `project.read` API key — no account-wide discovery exists outside the partner Console API
- Status from `GET /v1/project`; a `project_paused` error **is** the paused signal
- Two countdowns: days to the 7-day pause, and once paused, **days until the 90-day deletion**
- Alerts at pause-risk and at 7/30/60/80 days into the deletion window
- Copy that never overclaims: Keepstack *detects*, it does not prevent, because the pause is driven by Console activity. "Open in Console" is the fix, and it's the primary button

**Verify:** register a real Appwrite project, see the correct countdown, confirm the UI never
promises keep-alive, and confirm a paused project is detected.
**Must not break:** the honesty rule — an `alert_only` check is logged as a status check, never as
a successful keep-alive.

---

## ☐ Phase 8 — Cross-provider polish

Where five adapters start feeling like one product.

- **Paste anything, from any provider** — the search box runs every adapter's `parse()`: Supabase `.env`, Neon connection string, Atlas SRV URI, Upstash endpoint, Appwrite project ID
- Unified dashboard: provider filter, grouping, risk sort, "which account owns this?" answered across all five
- Alerts: email + Discord/Slack webhooks for pause risk, failing pings, quota headroom, deletion countdowns; per-user quiet hours
- Usage charts and a 90-day history view
- Onboarding that walks a new user from zero to first provider
- Export/import of the whole registry as JSON

**Verify:** paste one identifier from each of the five providers and get the right answer every
time. Trigger each alert type.

---

## ☐ Phase 9 — Open-source readiness

- README with screenshots, the honest security summary, and a **Deploy to Vercel** button
- `docs/SELF_HOSTING.md`, `docs/MIGRATION.md`, and **`docs/ADDING_A_PROVIDER.md`** — the contributor path, since one file + one registry line + one docs section is the whole story
- Fixture-based adapter tests (recorded provider responses, no live calls in CI), crypto unit tests, RLS tests
- GitHub Actions: typecheck, lint, test, `/security-review` on crypto and migration diffs
- Alternative scheduler workflow for self-hosters wanting 4×/day instead of Vercel Hobby's daily cron
- Demo mode with seeded fake data, so the repo is explorable without credentials
- Issue/PR templates, `SECURITY.md` disclosure contact, `good first issue` labels on the deferred providers

---

## After 1.0

In rough priority order:

- **Turso** — 10-day archiving and the only provider with a documented `unarchive` endpoint, i.e. true auto-revive. The strongest candidate for provider #6
- **Aiven** — free PG/MySQL/Valkey power off when idle and the API powers them back on; second real auto-revive
- **Render** — free Postgres is hard-deleted 30 days after creation; no keep-alive is possible, but the warning is valuable
- **Cloudflare D1 / KV** and **Firebase** — inventory only, no inactivity risk; Firebase needs Google service-account OAuth, a bigger lift than the rest combined
- CLI (`npx keepstack status`), browser extension that shows the owning account on a provider dashboard, team/shared registries, TOTP as a third unlock factor
