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

## ☐ Phase 1 — Supabase Auth with Google, and multi-user

Where it stops being a single-password personal tool.

- `@supabase/ssr`; Google OAuth + email/password; `/auth/callback`, `/auth/confirm`; middleware swapped off `APP_PASSWORD`
- `profiles` table and trigger; `user_id` on accounts and projects; **RLS on every table**
- Migration `0004` — the one-time claim flow: banner, service-role write, `audit_log` entry, then `KEEPSTACK_ALLOW_LEGACY_CLAIM` comes out of Vercel
- Account menu, sign-out, empty states for a brand-new user

**Verify:** sign in with Google, claim the legacy rows, see all your real data. Sign in as a second
account in a private window — it sees *nothing* of yours. Try reading another user's row directly
through the anon client; RLS refuses.
**Must not break:** the cron, which moves to a per-user loop under the service role.

---

## ☐ Phase 2 — The vault

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

---

## ☐ Phase 3 — Supabase, properly

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

---

## ☐ Phase 4 — Neon (the `watch` provider)

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

---

## ☐ Phase 5 — MongoDB Atlas

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
