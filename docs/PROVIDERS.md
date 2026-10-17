# Provider ecosystems

Research notes behind every adapter in Keepstack. Each provider gets the same treatment the
Supabase integration already has: how a project is *identified*, how it *dies*, how we *see* it,
how we *keep it alive*, and how we *bring it back*.

Verified October 2026. Free-tier policies change often — each section links its source, and
`lib/providers/<id>.ts` must keep its `policy` block in sync with what's written here.

---

## The two keep-alive models

Not every provider is kept alive by pinging it. Sorting them this way is the core design insight
of the multi-provider rewrite:

| Model | Meaning | Providers |
| --- | --- | --- |
| **`ping`** | Idleness is the threat. A periodic real query resets the inactivity clock. | Supabase, MongoDB Atlas, Upstash |
| **`watch`** | Idleness is free and automatic. The threat is a *quota* that pinging would waste. | Neon |
| **`alert_only`** | Idleness is the threat, but no API action can prevent it. We detect, count down, and nag. | Appwrite Cloud |

A provider's model is a property of its `policy`, not a user setting. The UI must never offer
"ping every 5 days" for Neon, because that would spend the user's compute budget to solve a
problem Neon does not have.

---

## 1. Supabase (Postgres) — `supabase`

The existing integration, massively upgradeable. Today the app stores a ref and an anon key and
pings a hand-made `keep_alive` table. With a Personal Access Token it can do all of that
automatically, plus far more.

**Identity.** A 20-char lowercase ref (`abcdefghijklmnopqrst`). Already extracted from URLs,
dashboard links, connection strings and whole `.env` files by `lib/ref.ts` — keep that, it is the
best feature in the app.

**Inactivity policy.** Free projects pause after **7 days** without activity. Paused projects keep
their data and can be restored from the dashboard or the API. Two free projects per organization.

**Management API.** `https://api.supabase.com/v1`, `Authorization: Bearer <PAT>`, 120 req/min per
user/endpoint. Scoped PATs can be limited to specific orgs and permissions — the setup guide must
tell users to create a **scoped** PAT, not a legacy one.

| Capability | Call |
| --- | --- |
| Discover | `GET /v1/projects` → `ref`, `name`, `region`, `status`, `organization_slug`, `database.host`, `created_at` |
| Status | `status` enum: `ACTIVE_HEALTHY`, `INACTIVE` (← this is *paused*), `PAUSING`, `RESTORING`, `PAUSE_FAILED`, `COMING_UP`, `GOING_DOWN`, `REMOVED`, … |
| Keys | `GET /v1/projects/{ref}/api-keys` — fetch the anon/publishable key automatically; no more pasting |
| **Ping (best)** | `POST /v1/projects/{ref}/database/query` with `{"query":"select 1","read_only":true}` — a real Postgres query, no `keep_alive` table needed. Marked **experimental/beta** in the spec, so treat it as the preferred path with fallbacks, not the only path |
| Ping (fallback) | `GET https://{ref}.supabase.co/rest/v1/{table}?select=*&limit=1` with the anon key — today's behaviour |
| Ping (weak) | `GET https://{ref}.supabase.co/auth/v1/health` |
| Health | `GET /v1/projects/{ref}/health?services=db,auth,rest` |
| **Revive** | `POST /v1/projects/{ref}/restore` (and `/restore/cancel`) — Keepstack can un-pause a project from its own UI |
| Rotate | `PATCH /v1/projects/{ref}/database/password` |
| Org context | `GET /v1/organizations`, `GET /v1/organizations/{slug}/projects` — lets us show real free-slot counts instead of assuming 2 |

**Secrets worth capturing.** Account login password (personal), PAT (server), anon key (server),
**database password** (personal by default — set at project creation, never retrievable
afterwards, and needed for `DATABASE_URL` / `DIRECT_URL` in Prisma/Drizzle).

**Open question for Phase 3.** `GET /v1/projects/{ref}/database/context` may return pooler host and
port, which would let us assemble pooled vs direct connection strings without hardcoding
`aws-0-<region>.pooler.supabase.com`. Verify against a live project before relying on it; fall
back to a stored per-project template.

Sources: [API intro](https://supabase.com/docs/reference/api/introduction),
[OpenAPI spec](https://api.supabase.com/api/v1-json)

---

## 2. Neon (Postgres) — `neon`

The `watch` provider. Including it forces the architecture to be honest: a "keeper" that only
knows how to ping would hurt a Neon user.

**Identity.** Project ID like `ep-cool-darkness-123456` / `fragrant-dew-12345678`, plus branch and
endpoint IDs. A Neon connection string carries the endpoint host, so paste-detection should map
host → project.

**Inactivity policy.** There isn't one, in the Supabase sense. Computes **scale to zero after 5
minutes** of inactivity and wake on the next connection; this cannot be disabled on the Free plan
and costs nothing. Nothing is paused or deleted for being idle.

The real risks are quotas, per project, per month:

- **100 CU-hours** of compute (a 0.25 CU compute ≈ 400 h/month)
- **0.5–1 GB** storage per project, 20 GB across all projects *(sources disagree on 0.5 vs 1 GB — read it from the API, don't hardcode)*
- **5 GB** public network transfer
- 100 projects, 10 branches per project, autoscale to 2 CU

**Blowing the CU-hour or transfer budget suspends the compute and drops connections until the next
billing period.** That is the Neon equivalent of "paused", and it is the thing Keepstack must warn
about — days of headroom left at the current burn rate.

**Management API.** `https://console.neon.tech/api/v2`, `Authorization: Bearer <neon_api_key>`.

| Capability | Call |
| --- | --- |
| Discover | `GET /projects`, `GET /projects/{id}`, `GET /users/me/organizations` |
| Topology | `GET /projects/{id}/branches`, `GET /projects/{id}/endpoints` |
| **Watch** | `GET /consumption_history/v2/projects` — requires `org_id`, `from`, `to` (RFC 3339), `granularity` (`hourly` ≤168 h, `daily` ≤60 d, `monthly` ≤1 y), `metrics` (`compute_unit_seconds`, `root_branch_bytes_month`, `public_network_transfer_bytes`, …). CU-seconds ÷ 3600 = CU-hours |
| Control | `POST /projects/{id}/endpoints/{eid}/suspend` and `/start` — we expose *suspend* as a "stop burning quota" button, the opposite of a ping |
| Rotate | `POST /projects/{id}/branches/{bid}/roles/{role}/reset_password` |

**Secrets.** Account login password (personal), Neon API key (server), role password /
`DATABASE_URL` (personal).

Sources: [Neon API](https://neon.com/docs/reference/api),
[free plan limits](https://neon.com/faqs/free-plan-limits-and-quotas),
[scale to zero](https://neon.com/docs/introduction/scale-to-zero),
[consumption metrics](https://neon.com/docs/guides/consumption-metrics)

---

## 3. MongoDB Atlas (M0) — `mongodb`

The hardest adapter, and the one that most justifies the project. Atlas is the only provider where
keeping alive needs a **real database driver connection**, because the Atlas Data API was removed
on **30 September 2025** — there is no HTTP query path left.

**Identity.** Org ID → Project ID (the API calls a project a **"group"**) → cluster name. One free
cluster per project, so a user with five free clusters has five Atlas projects.

**Inactivity policy.** Atlas pauses free clusters after **30 days of inactivity with zero
connections**, with a warning email 7 days before and another after. Resume is possible at any time
unless the paused cluster ran a MongoDB version Atlas can no longer restore. *(Some third-party
guides still say 60 days; the official free-cluster limits page says 30. Trust 30.)*

Other M0 limits worth surfacing in the UI: 0.5 GB storage, 500 connections, 100 ops/sec throttle,
10 GB in / 10 GB out per rolling 7 days, 100 databases / 500 collections, daily snapshots (4 kept).

**Management API.** `https://cloud.mongodb.com/api/atlas/v2`. Two auth options:

- **Service accounts (use this)** — OAuth 2.0 client credentials: `POST https://cloud.mongodb.com/api/oauth/token` with client ID + secret → a 1-hour Bearer token. Plain `fetch` works.
- **Programmatic API keys (avoid)** — HTTP **Digest** auth, which `fetch` does not implement; we'd have to hand-roll the MD5 challenge/response. Only add this if users demand it.

Every request needs a versioned Accept header: `Accept: application/vnd.atlas.<YYYY-MM-DD>+json`.
A missing or unknown version returns **406**. Pin one date in the adapter and treat bumping it as a
deliberate change.

| Capability | Call |
| --- | --- |
| Discover | `GET /orgs` → `GET /orgs/{orgId}/groups` → `GET /groups/{groupId}/clusters` |
| Status | `stateName` (`IDLE`, `CREATING`, `UPDATING`, `REPAIRING`) **plus** `paused` (boolean). `stateName` alone is ambiguous — a paused cluster can still read `IDLE`, so branch on `paused` |
| **Ping** | `mongodb` Node driver: connect with the SRV string, `db.admin().command({ ping: 1 })`, close. Node runtime only, dynamic import, short `serverSelectionTimeoutMS` |
| Revive | **Not via the Clusters API** — the docs state a free cluster can be created but *not modified* through it, and `{"paused": false}` is an M10+ operation. So: `alert_only` for revival, with a deep link to the cluster page |

**The IP allowlist problem, stated plainly.** A driver ping from Vercel comes from a rotating IP, so
the cluster's Network Access list has to contain `0.0.0.0/0`. The setup guide must say what that
means: the cluster is reachable from any IP, and its only protection is the SCRAM password. The
mitigations we document — and where sensible enforce — are: a **dedicated `keepstack-ping` database
user with `readAnyDatabase` only**, never the app's main user; and a note that self-hosters on a
fixed IP should allowlist just that address. If a user won't accept `0.0.0.0/0`, Atlas degrades
gracefully to `alert_only`: we still read `paused` from the Admin API and warn, we just can't
prevent the pause.

**Secrets.** Account login password (personal), service account client ID + secret (server), ping
user SRV connection string incl. password (server — must be, the cron uses it), app database
password (personal).

Sources: [free cluster limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/),
[pause/resume](https://www.mongodb.com/docs/atlas/pause-terminate-cluster/),
[service account auth](https://www.mongodb.com/developer/products/mongodb/mongodb-atlas-authentication-using-service-accounts-oauth),
[Data API deprecation](https://mongodb.com/docs/atlas/app-services/data-api/data-api-deprecation)

---

## 4. Upstash (Redis) — `upstash`

The cheapest ping in the set and a clean API. Also the clearest example of "archived, not paused".

**Identity.** `database_id` (UUID) plus an `endpoint` host like `xxx-yyy-12345.upstash.io`.

**Inactivity policy.** Free databases are **archived after a minimum of 14–30 days of inactivity**,
after several warning emails. Archiving means Upstash takes a backup and removes the instance; the
user restores by creating a new database and importing from the console. *(The FAQ exists in both a
14-day and a 30-day version with no dates — the adapter should assume the pessimistic **14** and
say so in the UI.)*

Free tier: 256 MB, 500K commands/month, 10 GB bandwidth/month, 10K commands/sec, 1 database.
Separately: no-signup databases from `/start-redis` are deleted after **3 days** unless claimed —
worth a loud warning if one is ever registered.

**Management API.** `https://api.upstash.com/v2`, **HTTP Basic auth with `email:api_key`** (account
email as username, Developer API key as password). Not available to accounts created through
Vercel or Fly.io — only native Upstash accounts, which the setup guide must state up front.

| Capability | Call |
| --- | --- |
| Discover | `GET /v2/redis/databases` → `database_id`, `database_name`, `endpoint`, `port`, `tls`, `state` (`active`/`suspended`/`passive`), `type` (`free`/`payg`/`pro`), `region`, `creation_time`, and the full `db_*` limit set |
| Detail | `GET /v2/redis/database/{id}` — takes a `credentials` query param whose documented purpose is to *hide* credentials, which implies the password and REST tokens are returned by default. **The published schema does not list those fields, so Phase 6 must confirm against a live account before the adapter depends on them**; the fallback is asking the user to paste the REST token once |
| **Ping** | `GET https://{endpoint}/ping` with `Authorization: Bearer <rest_token>` — the Upstash Redis REST API, one command against the 500K/month budget |
| Revive | No API. Console-only re-create + restore → `alert_only` once archived |

**Secrets.** Account login password (personal), management API key + email (server), per-database
REST token (server), Redis password (personal).

Sources: [Developer API intro](https://upstash.com/docs/devops/developer-api/introduction),
[auth](https://upstash.com/docs/devops/developer-api/authentication),
[list databases](https://upstash.com/docs/devops/developer-api/redis/list_databases.md),
[FAQ](https://upstash.com/docs/redis/help/faq), [pricing](https://upstash.com/pricing/redis)

---

## 5. Appwrite Cloud — `appwrite`

Included knowing its keep-alive story is the weakest of the five. It earns its place because it's
the BaaS hobbyists actually use, it's open source like Keepstack, and its policy is the most
dangerous in the set — it's the only provider here that **deletes your data**.

**Identity.** Project ID (hex string), inside an organization. Free plan: 2 projects per org,
1 database, 1 bucket, 2 functions per project.

**Inactivity policy — and why it's `alert_only`.** Per the February 2026 changelog, free projects
with **no development activity in the Console for 7 consecutive days are automatically paused**;
data is kept but the project is unreachable and background jobs stop. Per the June 2026 changelog,
a project left paused for **90 days is deleted with all its resources**. Resuming is done by
opening the project in the Console.

The trigger is *Console* activity. An API ping from Keepstack most likely does **not** count, and
there is no documented resume endpoint. So we must not promise to keep Appwrite projects alive.
What we can do, and what the adapter will do:

1. **Detect the pause** — API calls to a paused project fail with `project_paused` / "Project is paused due to inactivity". That error is a reliable signal, so a failing health check *is* the status check.
2. **Run the countdown** — days since last known activity → days until the 7-day pause; once paused, a prominent **days until deletion** counter against the 90-day clock.
3. **Nag** — the "Open in Console" button is the actual fix. Email/webhook alerts at pause-risk and at 7/30/60/80 days of the deletion window.

One community report claims pausing happened despite weekly use, and Appwrite staff described
pausing as a free-plan default. Unverified, but it's a reason to lean on detection over prevention.

**API.** `https://cloud.appwrite.io/v1`, headers `X-Appwrite-Project: <projectId>` and
`X-Appwrite-Key: <apiKey>`.

| Capability | Call |
| --- | --- |
| Discover | **No account-wide listing.** API keys are project-scoped, and listing all projects is a Console/organization-key operation documented only for partners. Projects are registered manually, one API key each — the one provider that keeps the old manual flow |
| Status | `GET /v1/project` (scope `project.read`) → name, region, labels; a `project_paused` error means paused |
| Health | `GET /v1/health` |
| Ping | Same calls, but recorded as `strategy: alert_only` — the UI must not claim the ping prevented anything |
| Revive | Console only |

**Secrets.** Account login password (personal), per-project API key (server).

Sources: [Feb 2026 changelog](https://appwrite.io/changelog/entry/2026-02-20-1),
[Jun 2026 changelog](https://appwrite.io/changelog/entry/2026-06-29),
[API keys](https://appwrite.io/docs/advanced/platform/api-keys), [pricing](https://appwrite.io/pricing)

---

## Policy matrix

| | Supabase | Neon | Atlas M0 | Upstash | Appwrite |
| --- | --- | --- | --- | --- | --- |
| Model | `ping` | `watch` | `ping` | `ping` | `alert_only` |
| Dies after | 7 d idle → paused | quota exhausted → suspended | 30 d idle → paused | ~14 d idle → archived | 7 d no console use → paused |
| Data deleted? | no | no | no | instance removed, backup kept | **yes, 90 d after pause** |
| Default interval | 5 d | n/a (daily read) | 20 d | 7 d | daily status check |
| Auto-discovery | ✅ PAT | ✅ API key | ✅ service account | ✅ email + key | ❌ manual |
| Ping transport | Mgmt API SQL | — | `mongodb` driver | Redis REST | — |
| Auto-revive | ✅ `/restore` | n/a | ❌ | ❌ | ❌ |
| Needs a password stored server-side | no | no | **yes** (SRV string) | no | no |

## Deliberately deferred

- **Turso** — 10-day archiving on free, clean bearer-token Platform API, and the only provider with a documented `POST /v1/organizations/{org}/groups/{group}/unarchive`, i.e. true auto-revive. The strongest candidate for provider #6.
- **Aiven** — free PG/MySQL/Valkey are powered off when idle and the API can power them back on. Second-best auto-revive candidate.
- **Render** — free Postgres is **hard-deleted 30 days after creation** and nothing can prevent it. No keep-alive value, high *alert* value.
- **Cloudflare D1 / Workers KV** — great API, no inactivity risk. Inventory-only.
- **Firebase** — the most famous of all, but no pause risk and management needs Google service-account OAuth. Inventory-only, and a bigger auth lift than the rest combined.
- **PlanetScale** — free Hobby plan retired April 2024 and not back. Out of scope.
