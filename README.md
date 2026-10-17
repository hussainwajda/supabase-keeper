# Keepstack

**One home for every free-tier database you own — across every account and every provider.**

If you build hobby projects, you've probably got databases scattered across five Supabase
accounts, a Neon project, a Mongo cluster you set up once, and a Redis instance you can't
remember signing up for. Keepstack answers the three questions that actually hurt:

- **"Which account owns this?"** Paste a project URL, a connection string, or a whole `.env`,
  and Keepstack tells you the owning account's email and how you log into it.
- **"Is anything about to die?"** Free tiers pause or delete idle projects. Keepstack knows each
  provider's policy, pings what can be pinged, watches quotas where pinging would waste them,
  and warns you about the rest.
- **"What was that password?"** Account logins and database passwords, encrypted, revealed only
  after a PIN or an emailed code — the way GitHub makes you re-authenticate before something
  destructive.

> **Status: Phase 2 of 9.** Keepstack is the multi-provider successor to `supabase-keeper`.
> Supabase works end to end today, with real accounts, row level security and an encrypted
> credential vault. Neon, MongoDB Atlas, Upstash and Appwrite land in Phases 4-7.
> See [docs/ROADMAP.md](docs/ROADMAP.md).

---

## Providers

| Provider | How it dies on the free tier | What Keepstack does |
| --- | --- | --- |
| **Supabase** | Paused after **7 days** idle | Pings a real Postgres query; auto-discovers projects, fetches anon keys, and can restore a paused project |
| **Neon** | Never paused — but **100 CU-hours/month** and exhausting it suspends your compute | Watches quota burn and warns on headroom. Deliberately never pings: that would spend the budget it's protecting |
| **MongoDB Atlas** | M0 paused after **30 days** with zero connections | Real driver connection (the Data API was removed in Sept 2025). Detects the paused state even when it can't prevent it |
| **Upstash** | Archived after **~14 days** idle | One-command Redis REST ping; tracks the 500K/month command budget |
| **Appwrite** | Paused after **7 days** without Console activity, then **deleted after 90 days** | Detects and counts down. Honest about the limit: the pause is driven by Console use, so no API ping prevents it |

The full research behind each adapter — endpoints, auth, policies, sources — is in
[docs/PROVIDERS.md](docs/PROVIDERS.md).

## How keep-alive actually works

Not every provider is kept alive by pinging it, and pretending otherwise would hurt users:

- **`ping`** — idleness is the threat, so a periodic real query resets the clock.
- **`watch`** — idleness is free and automatic; the threat is a quota that pinging would waste.
- **`alert_only`** — idleness is the threat, but no API action prevents it. Detect, count down, nag.

The model is a property of the provider, not a setting. A `watch` provider never shows you an
interval picker, and an `alert_only` check is logged as a status check — never as a keep-alive
that didn't happen.

## The vault

Two tiers, because two very different things get called "a secret":

- **Server tier** — provider API keys, anon keys. The nightly sweep must read these at 3am with
  nobody watching, so the server has to be able to decrypt them. Pretending otherwise would be
  security theatre.
- **Personal tier** — account login passwords, database passwords. Encrypted with a key wrapped
  by your PIN. Nothing in the sweep needs them.

Reading a personal secret needs a fresh PIN or an emailed code, in a 10-minute window, the way
GitHub makes you re-authenticate before something destructive. Revealed values re-mask after 30
seconds, the clipboard clears after 60, and every reveal — including failures — lands in an audit
log you can read on the Vault page.

Email recovery is optional. Without `RESEND_API_KEY` the PIN still works; only "I forgot my PIN"
needs email. And if you'd rather the server could never decrypt your personal secrets at all,
there's a one-way **no recovery** switch that deletes the recovery copy of your key — at the cost
of permanent loss if you forget the PIN.

## Security, briefly

Keepstack stores credentials, so the design is written down in full in
[docs/SECURITY.md](docs/SECURITY.md) — including what it **doesn't** protect against. The short
version:

- Secrets are split in two. **Server-tier** (provider API keys, anon keys) must be machine-readable
  because the nightly sweep runs unattended. **Personal-tier** (account logins, database passwords)
  is encrypted with a key wrapped by your PIN.
- Revealing a personal secret needs a fresh PIN or an emailed code, in a 10-minute session, and
  every reveal is written to an audit log you can read.
- **A deployment operator holding both the database and the environment can decrypt personal
  secrets.** That is the cost of offering PIN recovery by email. A per-user "no recovery" switch
  removes it at the cost of permanent loss if you forget the PIN.

If you're self-hosting for yourself, you are the operator and this reduces to trusting your own
Vercel account. If you deploy Keepstack for other people, tell them.

## Setup

Keepstack uses one Supabase project for two jobs: storing its own tables, and signing you in.
If any required variable is missing, the app serves a `/setup` page that names exactly what's
absent and where to find it — so you can follow that instead of this list.

1. **Environment.** Copy `.env.example` to `.env.local` and fill in three values from your
   registry project's **Project Settings → API Keys**:

   | | |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | the project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon / publishable key — safe in the browser, because RLS is what protects your rows |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role. **Never** prefix this with `NEXT_PUBLIC_` |

   Plus `CRON_SECRET` (`openssl rand -hex 32`).

   For the vault, also generate two **different** keys with `openssl rand -base64 32`:

   | | |
   | --- | --- |
   | `KEEPSTACK_MASTER_KEY` | encrypts server-tier secrets and the recovery copy of your key. **Back this up to a password manager before storing anything** — losing it makes every server-tier secret unrecoverable |
   | `KEEPSTACK_PIN_PEPPER` | mixed into the PIN key derivation, so a stolen database can't be brute-forced offline |

2. **Migrations.** In that project's SQL editor run `0001`, `0002`, `0003`, `0005` — **in that
   order, and stop there.**

   > `0004` and `0006` come *last*, after the app-side steps below. They verify work only the
   > running app can do, so they'll refuse to run until then (safely — a failed attempt changes
   > nothing). Full sequence: **[docs/MIGRATION.md](docs/MIGRATION.md)**.

3. **Google sign-in (optional).** Supabase dashboard → Authentication → Sign In / Providers →
   Google, with a client ID and secret from the [Google Cloud console](https://console.cloud.google.com/apis/credentials).
   Add these to the project's redirect allow-list:

   ```
   http://localhost:3000/auth/callback
   https://<your-app>/auth/callback
   ```

   Until it's configured, set `KEEPSTACK_DISABLE_GOOGLE=true` and use email + password.

4. **Sign in.** Google, or create an email + password account.

5. **Upgrading from supabase-keeper?** Migration `0003` turns on row level security, and rows
   created before sign-in existed have no owner — so the dashboard will look empty. It isn't:
   RLS hides unowned rows. Set `KEEPSTACK_ALLOW_LEGACY_CLAIM=true`, reload, and press
   **Claim these rows**. Then run `0004_require_owner.sql` and remove the flag.

   `0004` refuses to run while anything is still unclaimed, so it's safe to try early. Export
   your registry first with the **Export JSON** button if you want a copy on disk.

   Then set a **vault PIN** on the Vault page and press **Encrypt saved keys** on the dashboard:
   anon keys predate the vault and sit in a plaintext column. The sweep reads from either
   location, so nothing breaks while you do it. Finish with `0006_drop_plaintext_keys.sql`,
   which deletes that column and refuses to run while anything is still in it.

6. **Per-project keep-alive table (Supabase, optional).** Run `supabase/keep_alive.sql` in each
   project you want kept alive, so every ping is a real Postgres query rather than an
   API-gateway hit. The SQL is copyable from the project form. Phase 3 makes this unnecessary
   for accounts with a personal access token.

7. **Deploy.** `vercel deploy --prod` (or import the repo), then add the env vars. `vercel.json`
   registers the daily cron at 06:00 UTC; Vercel sends `Authorization: Bearer $CRON_SECRET`
   automatically. Set `NEXT_PUBLIC_SITE_URL` in production so OAuth links don't point at an
   internal proxy host.

### Local development

```bash
cp .env.example .env.local   # fill in
pnpm install && pnpm dev
```

### Running the sweep by hand

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://<app>/api/cron/sweep?force=1"
curl -H "Authorization: Bearer $CRON_SECRET" "https://<app>/api/cron/sweep?provider=supabase"
```

The cron runs **daily** (the Vercel Hobby limit), and each project is only pinged when it's due
by its own `interval_days`. Daily is plenty: the tightest policy in the set is 7 days.

## Contributing

Adding a provider is one file in `lib/providers/`, one line in `registry.ts`, and one section in
`docs/PROVIDERS.md`. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the adapter contract.

Turso, Aiven, Render, Cloudflare D1 and Firebase are all researched and deliberately deferred —
they're good first issues. The reasoning for each is at the bottom of `docs/PROVIDERS.md`.

## Docs

| | |
| --- | --- |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Every provider's ecosystem: endpoints, auth, inactivity policies, sources |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The adapter contract, data model, migration path, scheduler |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, key hierarchy, and the limits stated plainly |
| [docs/ROADMAP.md](docs/ROADMAP.md) | The nine phases and how each one is verified |
| [docs/MIGRATION.md](docs/MIGRATION.md) | The exact order of SQL migrations and app-side steps |

MIT licensed.
