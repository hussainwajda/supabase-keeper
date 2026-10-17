# Keepstack architecture

How `supabase-keeper` (single user, one provider, server-role DB access) becomes **Keepstack**
(many users, five providers, RLS, encrypted secrets) without losing a row of existing data.

Stack stays Next.js 15 App Router + React 19 + server actions on Vercel, with a Supabase Postgres
registry. Added: `@supabase/ssr` for real auth, Tailwind v4 + shadcn/ui for the UI, `mongodb` and
`pg` as Node-runtime-only dynamic imports.

---

## 1. The provider adapter contract

Everything provider-specific lives behind one interface. Nothing outside `lib/providers/` may
mention Supabase-the-provider, which is the discipline that keeps Supabase-the-registry and
Supabase-the-managed-provider from bleeding into each other.

```
lib/providers/
  types.ts        ProviderAdapter, Capability, Policy, normalised result types
  registry.ts     PROVIDERS: Record<ProviderId, ProviderAdapter>  — the only import site
  supabase.ts     ping via Management API SQL | anon REST | auth health; restore
  neon.ts         watch: consumption history, quota headroom; suspend endpoint
  mongodb.ts      service-account OAuth; driver ping (Node runtime only)
  upstash.ts      basic auth email:key; Redis REST /ping
  appwrite.ts     per-project key; paused detection; deletion countdown
```

```ts
export type ProviderId = "supabase" | "neon" | "mongodb" | "upstash" | "appwrite";
export type Strategy   = "ping" | "watch" | "alert_only";
export type Lifecycle  = "active" | "idle" | "paused" | "archived" | "deleted" | "unknown";

/** What a provider can actually do — the UI renders from these, never from `if (provider === …)`. */
export type Capabilities = {
  discover: boolean;   // list projects from an account credential
  ping: boolean;       // an action that resets the inactivity clock
  watch: boolean;      // quota/usage metrics worth charting
  revive: boolean;     // un-pause / un-archive from our UI
  health: boolean;     // richer per-service status
  rotate: boolean;     // rotate a database/role password
};

export type Policy = {
  strategy: Strategy;
  /** Days of inactivity before the provider acts. null = no inactivity policy. */
  pausesAfterDays: number | null;
  /** Days after pausing until data is destroyed. null = data kept indefinitely. */
  deletesAfterDays: number | null;
  /** What the provider calls it, for honest copy: "paused" | "archived" | "powered off". */
  pauseNoun: string;
  defaultIntervalDays: number;
  /** One sentence shown in the UI. Must match docs/PROVIDERS.md. */
  summary: string;
  docsUrl: string;
};

/** A field we ask the user for. `tier` decides which key encrypts it (see SECURITY.md). */
export type CredentialField = {
  key: string;                    // 'pat' | 'api_key' | 'db_password' | …
  label: string;
  help: string;
  secret: boolean;
  required: boolean;
  tier: "server" | "personal";
  /** Cheap client-side sanity check, e.g. reject a service_role JWT in an anon-key field. */
  validate?: (v: string) => string | null;
};

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  accent: string;                 // brand colour token
  capabilities: Capabilities;
  policy: Policy;

  accountFields: CredentialField[];   // what an *account* needs for API access
  projectFields: CredentialField[];   // what a *project* needs

  /** Paste-anything search: pull an external id out of a URL, connection string or .env blob. */
  parse(input: string): { externalId: string; hint?: string } | null;
  consoleUrl(p: ProjectRef): string;

  discover?(cred: Creds): Promise<Discovered[]>;
  ping?(p: ProjectRef, cred: Creds): Promise<PingOutcome>;
  status?(p: ProjectRef, cred: Creds): Promise<{ lifecycle: Lifecycle; raw: string }>;
  usage?(p: ProjectRef, cred: Creds): Promise<UsageSnapshot[]>;
  revive?(p: ProjectRef, cred: Creds): Promise<void>;
  /** Assemble DATABASE_URL / DIRECT_URL once the vault has handed over the db password. */
  connectionStrings?(p: ProjectRef, secrets: Record<string, string>): ConnectionStrings;
}
```

Three rules that keep this honest:

1. **`ping` never lies.** A `PingOutcome` carries the `strategy` it ran under. An `alert_only` ping
   is recorded as a *status check*, and the UI says "checked", not "kept alive".
2. **Capabilities drive the UI.** No `if (provider === "neon")` outside `lib/providers/`. Neon shows
   a quota card instead of an interval picker because `capabilities.ping === false`.
3. **Adapters are pure-ish.** They take credentials and return data. They never touch the registry
   DB, never read `process.env`, and never decrypt anything — callers hand them plaintext. That's
   what makes them unit-testable against recorded fixtures and safe for contributors to write.

Adding a provider = one file + one registry line + one section in `docs/PROVIDERS.md`. That is the
contributor story, and `docs/ADDING_A_PROVIDER.md` in Phase 9 writes it down.

---

## 2. Data model

Multi-user from Phase 1 onward. Every table carries `user_id` and is protected by RLS
(`user_id = auth.uid()`); the cron is the only service-role caller and loops per user.

```
auth.users                          (Supabase Auth — Google OAuth + email/password)
profiles        id→auth.users, display_name, avatar_url,
                vault_initialized_at, pin_salt, dek_pin, dek_srv,
                pin_failed_attempts, pin_locked_until
accounts        user_id, provider, email, label, login_method, notes,
                last_synced_at, last_sync_status, last_sync_error
                unique (user_id, provider, email)
projects        user_id, account_id, provider, external_id, name, region, plan,
                provider_status, lifecycle, keep_alive, strategy, interval_days,
                repo_url, local_path, notes, metadata jsonb,
                last_pinged_at, last_status, last_error, discovered_at
                unique (user_id, provider, external_id)
secrets         user_id, account_id?, project_id?, kind, label, tier,
                ciphertext, iv, key_version, last_used_at, last_verified_at
                check (account_id is not null or project_id is not null)
vault_sessions  user_id, token_hash, dek_sealed, iv, method, expires_at
otp_challenges  user_id, code_hash, purpose, attempts, consumed_at, expires_at
audit_log       user_id, action, target_type, target_id, method, ip, user_agent, detail jsonb
ping_logs       project_id, strategy, status, http_status, duration_ms, error
usage_snapshots project_id, metric, value, limit_value, period_start, period_end, captured_at
```

Notes on shape:

- **`provider` is a Postgres enum.** Adding a provider is then a migration, which is the right
  amount of friction — it forces the docs update too.
- **`external_id` replaces `ref`.** A Supabase ref, a Neon project id, an Atlas `group/cluster`
  pair and an Upstash UUID all live in one column; anything structured goes in `metadata`
  (`{ org_slug, group_id, cluster_name, endpoint, host, port, group }`).
- **`strategy` is stored, not just derived.** It's seeded from the adapter's policy so historical
  `ping_logs` stay interpretable after a provider changes its rules.
- **One `secrets` table, not two.** Polymorphic owner (`account_id` *or* `project_id`) beats two
  near-identical tables, and the vault UI gets one code path.
- **`usage_snapshots` is append-only and narrow.** `(project_id, metric, value, limit_value)` charts
  Neon CU-hours, Upstash commands and Atlas transfer with the same component.

---

## 3. Migration: keeping the real data

The registry already holds real accounts and projects. Non-negotiable.

**Before anything:** `docs/MIGRATION.md` opens with an export step —
`supabase db dump --data-only` plus a one-click **Export JSON** button added in Phase 0, so there's
a copy of the registry that doesn't depend on any of this going right.

Migrations are additive and ordered so the app keeps working after each one:

| # | Migration | Effect |
| --- | --- | --- |
| `0002` | provider enum; `provider` on accounts/projects **default `'supabase'`**; `external_id` backfilled from `ref`; `metadata`, `lifecycle`, `strategy`; keep `ref` as a nullable legacy column | Phase 0 ships, old queries still resolve |
| `0003` | `profiles`; `user_id` (nullable) on accounts/projects; RLS policies; `audit_log` | Phase 1 |
| `0004` | **Claim**: set `user_id` on every orphan row to the first authenticated user, then `set not null` | Phase 1, run once |
| `0005` | `secrets`, `vault_sessions`, `otp_challenges`; move `projects.anon_key` → `secrets(kind:'anon_key', tier:'server')` **encrypted**; drop the plaintext column | Phase 2 |
| `0006` | `usage_snapshots`; `ping_logs.strategy`; drop `projects.ref` and `ping_table` once nothing reads them | Phase 4 |

**The claim step** is the only fiddly part. Rows predate auth, so they have no owner. On first
Google sign-in, if `select count(*) from projects where user_id is null` > 0 **and**
`KEEPSTACK_ALLOW_LEGACY_CLAIM=true`, the dashboard shows a one-time banner: *"5 accounts and
11 projects from before sign-in was added. Claim them?"* It runs under service role, writes an
`audit_log` entry, and the env flag is then removed from Vercel. A public deployment never has the
flag set, so no stranger can claim anything.

**`anon_key` is currently plaintext in the database.** Migration `0005` fixes that — it is a real
security improvement, not just a move, and it's why the encryption phase comes before the new
providers.

---

## 4. The scheduler

Today: one Vercel cron, daily, pings every due Supabase project. Multi-provider needs more care
inside the same constraints (Hobby = one cron run per day, 60 s per invocation).

```
app/api/cron/sweep/route.ts
  for each user:
    for each enabled project, grouped by provider:
      resolve strategy →
        ping        : adapter.ping()      if due by interval_days
        watch       : adapter.usage()     daily, cheap, never a ping
        alert_only  : adapter.status()    daily
      write ping_logs / usage_snapshots, update projects.lifecycle
  evaluate alert rules → email + webhook
  prune ping_logs > 90 d, usage_snapshots > 400 d
```

- **Bounded concurrency** (a small `pLimit`-style helper, ~6 at a time) so 50 projects don't open 50 sockets or trip provider rate limits — Supabase's is 120 req/min per endpoint.
- **Per-provider isolation:** one provider's outage must not starve the others of the 60 s budget. Each provider group gets a deadline; what doesn't finish is marked `skipped` and retried next run.
- **`?provider=` and `?project=` filters** for manual runs and debugging.
- **Daily is enough.** The tightest policy in the set is 7 days (Supabase, Appwrite), so a daily sweep with per-project intervals has plenty of margin. The keep-alive slack logic already in `lib/ping.ts` carries over.
- **GitHub Actions as an alternative scheduler** for self-hosters who want 4×/day — a workflow that curls the endpoint with `CRON_SECRET`. Documented in Phase 9; the endpoint is the same.

---

## 5. Target layout

```
app/
  (auth)/login, auth/callback, auth/confirm
  (app)/page.tsx                    unified dashboard, all providers
        accounts/                   grouped by provider, sync buttons
        projects/[id]/              per-project detail, logs, usage, secrets
        projects/new/
        vault/                      PIN setup, audit log, secret inventory
        settings/                   alerts, email, webhooks, export
  api/cron/sweep/
  api/vault/unlock|reveal|otp/      Node runtime, rate-limited, never cached
lib/
  providers/                        the five adapters + registry
  crypto/                           envelope encryption, KDF, sealing
  vault/                            unlock sessions, OTP, reveal, audit
  registry/                         typed data access (replaces lib/db.ts)
  supabase/                         server/browser/service clients (@supabase/ssr)
  alerts/                           rules, email, webhooks
components/
  providers/                        badges, policy pills, per-provider cards
  vault/                            unlock dialog, reveal field, copy-and-clear
  ui/                               shadcn primitives
supabase/migrations/                0001 … 0006
docs/                               PROVIDERS, ARCHITECTURE, SECURITY, ROADMAP,
                                    MIGRATION, ADDING_A_PROVIDER
```

`lib/ref.ts` becomes `lib/providers/supabase.ts#parse`, and the paste-anything search box queries
every adapter's `parse()` in turn — so pasting a Neon connection string, an Upstash endpoint or an
Atlas SRV URI works exactly like pasting a Supabase `.env` does today. That search box is the
feature users will recognise; it has to get *better* in the rewrite, not worse.
