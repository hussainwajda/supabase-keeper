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

> **Status: Phase 0 of 9.** Keepstack is the multi-provider successor to `supabase-keeper`.
> Supabase works end to end today; Neon, MongoDB Atlas, Upstash and Appwrite land in
> Phases 4-7. See [docs/ROADMAP.md](docs/ROADMAP.md).

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

1. **Registry database.** Pick one Supabase project to hold Keepstack's tables. Run
   `supabase/migrations/0001_initial.sql`, then `0002_multi_provider.sql`, in its SQL editor.
   The nightly sweep queries this database, so the registry keeps itself active.
2. **Per-project keep-alive table (Supabase, optional).** Run `supabase/keep_alive.sql` in each
   project you want kept alive, so every ping is a real Postgres query rather than an
   API-gateway hit. The SQL is copyable from the project form. Phase 3 makes this unnecessary
   for accounts with a personal access token.
3. **Environment.** Copy `.env.example` to `.env.local` and fill it in.
4. **Deploy.** `vercel deploy --prod` (or import the repo), then add the env vars. `vercel.json`
   registers the daily cron at 06:00 UTC; Vercel sends `Authorization: Bearer $CRON_SECRET`
   automatically.
5. Log in, add your accounts, then add projects.

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

MIT licensed.
