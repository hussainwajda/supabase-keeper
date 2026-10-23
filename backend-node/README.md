# backend-node

Keepstack's optional backend: the same registry, vault and provider logic as the Next.js app,
behind a REST API, with **MongoDB as the database and no Supabase anywhere** — not for data,
and not for sign-in either.

It is a separate package with its own `package.json`. Installing the Next.js app doesn't pull
Express or the MongoDB driver in, and this directory can be copied out and deployed on its own.

---

## Running it with the Next.js frontend

From the repo root, one command starts both and points the frontend here:

```bash
pnpm dev --nodejs       # or: pnpm dev:node
```

It waits for `/health` before booting Next.js, prefixes both logs, and sets
`KEEPSTACK_BACKEND=node` for that run. For a deployment set `KEEPSTACK_BACKEND=node` and
`KEEPSTACK_API_URL` permanently. The same UI renders either backend — see
[docs/ARCHITECTURE.md §9](docs/ARCHITECTURE.md) for how the switch works and the two things
that differ (Google sign-in, and the migration banners).

To run this service on its own, read on.

## Quick start

```bash
cd backend-node
pnpm install
cp .env.example .env          # MONGODB_URI is the only variable with no default

# Generate the two vault keys. They must be different values.
#   MIGRATING? Use the SAME values your Supabase deployment uses — see docs/MIGRATION.md.
openssl rand -base64 32       # -> KEEPSTACK_MASTER_KEY
openssl rand -base64 32       # -> KEEPSTACK_PIN_PEPPER

pnpm dev                      # http://localhost:4000
```

```bash
curl localhost:4000/health
# { "ok": true, "backend": "node-mongodb", "mongo": "connected", "vault": "configured", … }
```

Create the first account. Signup is closed by default — a self-hosted Keepstack is usually one
person's — but the *first* user is always allowed through, so a fresh deployment can bootstrap
itself. The window closes as soon as one user exists.

```bash
curl -c jar -X POST localhost:4000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-enough-password"}'

curl -b jar localhost:4000/auth/me
```

| Script | What it does |
| --- | --- |
| `pnpm dev` | Watch mode |
| `pnpm start` | Run it |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | 106 tests, no services needed |
| `pnpm indexes` | Apply the indexes and print what's there |
| `pnpm migrate` | Copy an existing Supabase registry in — see [docs/MIGRATION.md](docs/MIGRATION.md) |
| `pnpm set-password -- you@example.com` | Set a password (migrated accounts arrive without one) |

Runtime dependencies are `express`, `mongodb` and `tsx`. Password hashing, AES-GCM, scrypt,
HKDF, UUIDs and the OAuth exchange all use `node:crypto` and `fetch` — a service whose job is
holding other people's credentials is the wrong place to be casual about `node_modules`.

---

## What it is

```
backend-node/src/
  index.ts         boot: connect → apply indexes → listen
  server.ts        the Express app, assembled separately so it can be built without listening
  config/env.ts    every environment variable, with an actionable error for each

  db/              documents.ts   one collection per SQL table
                   indexes.ts     every constraint the DDL used to express
                   scope.ts       the RLS replacement  ← read this one first
                   validate.ts    the CHECK constraints
                   ids.ts         why primary keys are UUID strings

  auth/            password.ts    scrypt, self-describing hashes
                   sessions.ts    opaque tokens in an httpOnly cookie
                   google.ts      the OAuth code flow, by hand (optional)
                   middleware.ts  requireUser → mints the request's Scope

  crypto/          ported from lib/crypto/ with no changes but dropping "server-only"
  providers/       the four adapters, ported verbatim, plus sync.ts rewritten for MongoDB
  vault/           PIN, OTP, sudo sessions, secrets, audit — same crypto, MongoDB underneath
  registry/        accounts, projects, logs, export
  jobs/            ping.ts, usage.ts, the sweep, and an in-process scheduler
  http/            errors, serialisers, cookies, CORS
```

Two things are worth knowing before reading the code.

**The adapters and the crypto were copied, not rewritten.** `src/providers/{supabase,neon,mongodb,upstash}.ts`
and `src/crypto/*` are byte-identical to the Next.js app's except for a deleted
`import "server-only"` line. That's not luck — it's the architecture rule in
[docs/ARCHITECTURE.md §1](../docs/ARCHITECTURE.md) ("adapters never touch the registry DB,
never read `process.env`, never decrypt anything") paying off the first time it was tested.
The app's own test suites run here unchanged and pass, which is the evidence the vault survived
the move.

**`src/db/scope.ts` is the most important file.** It replaces row level security, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains what that costs and how the cost is
contained.

---

## Postgres → MongoDB, at a glance

| Postgres | Here | Note |
| --- | --- | --- |
| Row level security | `Scope`, a nominal type | Can't be made from a string; query helpers require one |
| `uuid primary key default gen_random_uuid()` | UUID string `_id` | Preserved on migration — ciphertexts are bound to user ids |
| `unique (user_id, provider, external_id)` | Unique compound index | Same guarantee |
| `unique (account_id, kind) where account_id is not null` | Unique index + `partialFilterExpression` | A plain unique index would collide on `null` |
| `provider_id` enum, `check (…)` | `src/db/validate.ts` | Named field and allowed values in the error |
| `on delete cascade` | Explicit, children first | No transaction — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| `on delete set null` | Explicit `$set: {account_id: null}` | Deleting an account keeps its projects |
| `upsert … on conflict (project_id, metric, captured_on)` | `updateOne(…, {upsert: true})` | One usage reading per metric per UTC day |
| `delete … where created_at < now() - 90 days` | TTL index | MongoDB enforces retention; the sweep doesn't |
| `auth.users` + `profiles` + trigger | One `users` document | Nothing to keep in step |
| Supabase Auth sessions | `auth_sessions` + httpOnly cookie | Revocable, which a JWT isn't |
| SQL migration files | `ensureIndexes()` at boot | No `schemaStatus()`, no `forWrite()` |

The full reasoning, including what got *worse* and what is genuinely better, is in
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## API

Cookie-authenticated (`ks_session`). All responses are JSON; errors are
`{ error, code, detail? }`.

### Auth
| | |
| --- | --- |
| `GET /auth/config` | Whether Google and signup are available |
| `POST /auth/signup` | `{email, password, display_name?}` |
| `POST /auth/login` | `{email, password}` → sets the session cookie |
| `POST /auth/logout` | Closes the vault first, then the session |
| `GET /auth/me` | The signed-in user |
| `POST /auth/password` | `{current_password, new_password}` — revokes other sessions |
| `POST /auth/sessions/revoke-all` | Sign out everywhere |
| `GET /auth/google` → `/auth/google/callback` | Only when `GOOGLE_CLIENT_ID` is set |

### Registry
| | |
| --- | --- |
| `GET/POST /api/accounts`, `PATCH/DELETE /api/accounts/:id` | `GET` also returns `slots_used` |
| `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` | `GET` list includes `has_key` |
| `GET /api/projects/:id/logs?limit=` | Ping history |
| `GET /api/projects/:id/usage` | Latest reading per metric |
| `GET /api/projects/:id/usage/:metric?days=` | History for a sparkline |
| `GET /api/export` | Full export, secrets excluded |

### Providers
| | |
| --- | --- |
| `GET /api/providers` | **Public.** Provider metadata, validators stripped |
| `POST /api/parse` | Paste-anything: a URL, a connection string, a whole `.env` |
| `POST /api/accounts/:id/sync/preview` | A plan. Writes nothing |
| `POST /api/accounts/:id/sync/apply` | Re-plans server-side, then applies |
| `POST /api/projects/:id/ping` | Routed by strategy — a `watch` provider is never pinged |
| `POST /api/ping-all` | Narrowed to the caller |
| `POST /api/projects/:id/status` · `/usage` · `/restore` · `/keys` | Provider actions |
| `GET /api/projects/:id/health` | Per-service status, not stored |
| `POST /api/projects/:id/connection-strings` | Needs an unlocked vault |

### Vault
| | |
| --- | --- |
| `GET /api/vault/status` | PIN, lock state, remaining seconds, OTP availability |
| `POST /api/vault/pin` · `PATCH /api/vault/pin` · `POST /api/vault/pin/reset` | Setup, change, reset |
| `POST /api/vault/unlock/pin` · `/unlock/otp` · `POST /api/vault/otp` | 10-minute sudo |
| `POST /api/vault/lock` · `/lock-all` · `GET /api/vault/sessions` | |
| `DELETE /api/vault/recovery` | Irreversible. Needs the phrase `no recovery` |
| `GET/POST /api/vault/secrets`, `DELETE /api/vault/secrets/:id` | Summaries never include ciphertext |
| `POST /api/vault/secrets/:id/reveal` | Audited, `Cache-Control: no-store` |
| `GET /api/vault/audit` | Read-only by construction |

### Scheduler
| | |
| --- | --- |
| `GET/POST /api/cron/sweep?force=1&provider=` | `Authorization: Bearer $CRON_SECRET` |

Same contract as the Next.js app's cron route, so an existing Vercel Cron entry, GitHub Actions
workflow or `curl` in a crontab points at this with no change but the host. Or set
`ENABLE_SCHEDULER=true` and the process sweeps itself — see below.

---

## The scheduler

On Vercel the sweep is capped at **one run per day** (Hobby) with a hard **60-second**
ceiling per invocation, and `pingProjects()` is shaped around both: bounded concurrency,
per-provider deadlines, and projects reported as `skipped` rather than silently dropped when
the budget runs out.

A long-lived Node process has neither limit:

```bash
ENABLE_SCHEDULER=true
SCHEDULER_INTERVAL_HOURS=6     # four sweeps a day, nothing external to configure
```

The per-provider budget stays, now as a self-imposed bound rather than a survival tactic — a
sweep that runs for twenty minutes because one provider is timing out is a sweep nobody can
reason about, and skipped projects are retried on the next run.

---

## Deploying

Any host that runs a Node process and can reach MongoDB. Set the environment from
`.env.example`, then:

```bash
pnpm install --prod && pnpm start
```

- **`PUBLIC_URL`** — this API's own URL. Google's authorised redirect URI must be
  `$PUBLIC_URL/auth/google/callback`.
- **`CORS_ORIGIN`** — the frontend's exact origin. Cookie auth can't use a wildcard, so this
  is a list of origins, not `*`.
- **Cross-site frontend** — set `COOKIE_SAMESITE=none`, which requires `COOKIE_SECURE=true`,
  which requires HTTPS. Same-site deployments need neither.
- **Behind a proxy** — `trust proxy` is on, so `secure` cookies and audit IPs come from the
  forwarded headers.
- **`KEEPSTACK_MASTER_KEY`** — back it up before storing anything. Lose it and every
  server-tier secret is unrecoverable. This is not a backend-specific warning; it's
  [docs/SECURITY.md](../docs/SECURITY.md).

A missing vault key is a startup **warning**, not a fatal error: the sweep still has to run for
projects whose credentials are public, so refusing to boot would stop keep-alives in order to
complain about a feature that may not be in use. Every path that needs a key fails with the
same explanation.

---

## Migrating from Supabase

`pnpm migrate` copies your accounts, projects, secrets, logs and audit trail across, **keeping
your vault PIN working and every stored credential decryptable**. It is re-runnable and has a
`--dry-run`.

The one thing that must not be got wrong is why: every secret is sealed with AAD that includes
the user id, so a reissued id makes the ciphertext undecryptable forever. The migration
preserves primary keys for exactly that reason.

Full procedure, including the rollback: **[docs/MIGRATION.md](docs/MIGRATION.md)**.
