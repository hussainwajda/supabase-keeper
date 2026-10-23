# The port: Supabase Postgres → Node + MongoDB

What actually changed, what it cost, and what it bought. Read along
[`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md), which this does not repeat.

The short version: **two thirds of the codebase moved without being edited.** The parts that
had to be rewritten are the parts that touched Postgres, and the one genuinely hard problem was
that Postgres was enforcing a security property the application was relying on and no longer
gets for free.

---

## 1. What moved unchanged, and why that is the interesting result

| Moved verbatim | Lines | Edit needed |
| --- | --- | --- |
| `lib/providers/{supabase,neon,mongodb,upstash}.ts` | ~2,040 | none |
| `lib/providers/types.ts`, `registry.ts`, `options.ts` | ~350 | none |
| `lib/crypto/{aead,dek,env,secrets}.ts` | ~310 | none |
| `lib/concurrency.ts` | 70 | none |
| `lib/vault/{email,kinds}.ts` | ~115 | one import path |

The only change to any of them was deleting `import "server-only"`, a Next.js directive with no
meaning outside Next.

This is the architecture rule from §1 of the main document being tested for the first time:

> Adapters are pure-ish. They take credentials and return data. They never touch the registry
> DB, never read `process.env`, and never decrypt anything — callers hand them plaintext.

It was written as a contributor-friendliness and testability argument. It turns out to also be a
portability argument: a database swap touched none of the provider code, because none of the
provider code knew there was a database. The same is true of `lib/crypto/` — it takes buffers
and strings and returns strings.

**The evidence, not just the claim:** the Next.js app's own two test suites — `crypto.test.ts`
(26 tests) and `providers/registry.test.ts` (14 suites) — run here against the ported files with
only their import paths rewritten, and pass. 68 tests. If the move had broken the AEAD envelope
format, the AAD binding, the scrypt parameters or any adapter's parsing, those tests would say
so. A further 38 cover the new code, for 106 in total, and none of them needs a database or a
network.

---

## 2. The hard problem: RLS has no MongoDB equivalent

This is the part worth dwelling on, because it is the only place where the move made something
genuinely worse.

Every table in the Supabase schema carries `user_id` and a policy:

```sql
create policy "projects: own" on public.projects
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
```

`lib/registry/queries.ts` then contains **no ownership filter anywhere**, and says why:

> Every read and write below runs as the signed-in user by default, so RLS in Postgres is what
> scopes the data — not a `.eq("user_id", …)` we might forget.

That is a strong property. A SQL injection, a mistaken `select *`, a forgotten filter, a bug in
a route that passes an id straight through — none of them could return another user's row,
because the database refused regardless of what the query asked for. The guarantee lived below
the application, so application bugs couldn't reach it.

MongoDB has no equivalent. There is no per-document policy engine, and the credentials this
service connects with can read every document in the database. The guarantee therefore has to
move *into* the application, which is a strictly weaker position — and the only remaining
question is whether it moves somewhere disciplined, or gets sprinkled across every call site
where forgetting it once is a cross-tenant leak no test is likely to catch.

### What was done instead

`src/db/scope.ts` makes ownership a **nominal type** rather than a convention:

```ts
declare const scopeBrand: unique symbol;
export type Scope = { readonly userId: string; readonly [scopeBrand]: true };

export function scopeFor(userId: string): Scope { … }

export function owned<T extends { user_id: string }>(scope: Scope, filter: Filter<T> = {}) {
  return { ...filter, user_id: scope.userId };   // the scope is applied LAST, so it wins
}
```

Three properties follow:

1. **A `Scope` cannot be built from a string.** The brand makes `{ userId: "…" }` not assignable,
   so the only way to get one is `scopeFor()` — which the auth middleware calls in exactly one
   place, after authenticating the request.
2. **Every query helper takes a `Scope`.** `listProjects(scope)`, `findProject(scope, id)`,
   `putSecret({scope, …})`. An unscoped read is a type error, not a judgement call.
3. **The scope wins over the caller.** `owned()` spreads `user_id` last and overwrites anything
   the filter already had. A route that passes a user-supplied field into a filter cannot
   escalate; `src/__tests__/backend.test.ts` asserts this directly, because it is the one
   assertion whose failure would be a cross-tenant read.

Two deliberate exceptions, both commented at the point of use:

- `keepAliveProjects(userId?)` — the sweep has no user session and must cover everybody. This is
  the service-role query from the Postgres version, and `userId` narrows it when a signed-in
  user presses "Ping all now", so one person's action never pulls another's projects into the
  process.
- The migration script, which is assigning ownership by definition.

### The property that survived for free

Error messages don't confirm existence. `notFound()` says *"That project doesn't exist, or
isn't yours"*, never *"that isn't yours"* — because the scoped query genuinely cannot tell the
two apart. In Postgres, RLS gave that for nothing. Here it comes from scoping the lookup rather
than checking ownership after fetching, which is the same thing done one layer up.

### An honest accounting

| | Supabase | Here |
| --- | --- | --- |
| Enforced by | Postgres, below the app | TypeScript + one module, inside the app |
| Survives an app bug | Yes | Only if the bug isn't in that module |
| Survives a compromised connection string | Yes (anon key + RLS) | No |
| Visible in the code | No — absence is the design | Yes — `scope` in every signature |

The last row cuts both ways. The Supabase version is safer; this version is more obvious. What
makes the trade acceptable is that the enforcement is one 60-line file with a test asserting its
one critical property, rather than a habit spread across forty route handlers.

---

## 3. What got better

Not everything was a downgrade. Four things are genuinely better, and one is a capability that
didn't exist.

### TTL indexes replaced retention code

The Postgres sweep ended with housekeeping:

```ts
await supabaseService().from("ping_logs").delete()
  .lt("created_at", new Date(Date.now() - 90 * DAY_MS).toISOString());
```

…plus `pruneExpiredSessions()` for vault sessions and OTP challenges. All of it is retention
policy, and MongoDB enforces retention natively:

```
ping_logs.created_at        expireAfterSeconds = 7,776,000   (90 days)
usage_snapshots.captured_at expireAfterSeconds = 34,560,000  (400 days)
vault_sessions.expires_at   expireAfterSeconds = 0           (when the date passes)
otp_challenges.expires_at   expireAfterSeconds = 0
auth_sessions.expires_at    expireAfterSeconds = 0
```

The sweep now spends its whole budget on the work it was called for. One caveat, handled: the
TTL monitor runs about once a minute, so a document can outlive its `expires_at` briefly. That
is fine for housekeeping and **not** fine for authentication, so `currentDek()` and
`currentUser()` still compare the date explicitly. The index keeps the collection tidy; the
comparison is what ends the session.

### Atomic counters closed a real race

`recordFailure` in `lib/vault/pin.ts` reads the attempt count, adds one in application code,
and writes it back. Five wrong PINs submitted simultaneously could each read `0`, each write
`1`, and **the lockout would never trigger** — a brute-force mitigation defeated by
concurrency. `src/vault/pin.ts` uses `$inc` in a single `findOneAndUpdate`, so every attempt is
counted even when they arrive together. `verifyOtp` had the same shape and got the same fix,
plus the consume became `updateOne({_id, consumed_at: null})` so two requests carrying the same
correct code can't both be granted an unlock — the write arbitrates the race.

### No migration files, and so no schema-drift code

The Supabase app carries machinery that exists only because its SQL is run by a human at an
unknown time relative to the deploy:

- `schemaStatus()` — probes for a post-0002 column, caches the answer
- `forWrite()` — strips columns from a write when the migration hasn't run
- `normalizeProject()` — reads degrade to the pre-0002 shape
- `vaultSchemaReady()` — same question for the vault tables
- `hasLegacyColumns()` — and the same again for columns 0006 *dropped*

Comments throughout explain the asymmetry: "reads normalise, writes narrow." `ensureIndexes()`
runs at boot, before the first request is served, so the window doesn't exist and none of that
code has a counterpart here. `src/jobs/ping.ts#toProjectRef` is one line shorter than the
original for precisely this reason.

### Upserts replaced select-then-insert

`putSecret` in the Supabase version selects, then inserts or updates. Two concurrent saves of the
same credential both find nothing and both insert; the unique index stops the second, and the
user gets a 409 to make sense of. Here it is one `findOneAndUpdate` with `upsert: true`, so the
server resolves it and the index is a backstop rather than the mechanism.

### A scheduler that can actually schedule

Vercel Hobby allows **one cron run per day** with a hard 60-second ceiling per invocation. Those
two numbers shaped `pingProjects()` more than anything else in it. A long-lived process has
neither limit, so `ENABLE_SCHEDULER=true` plus `SCHEDULER_INTERVAL_HOURS=6` gives four sweeps a
day with nothing external configured. The HTTP endpoint stays, with the identical
`Bearer $CRON_SECRET` contract, because an endpoint is still the only way to trigger a run by
hand.

The overlap guard is the part worth noting: a sweep slower than the interval would otherwise
start a second run mid-flight, and two concurrent sweeps would ping the same projects twice and
race each other's writes. Skipping is right rather than queueing — the work is idempotent and
the next tick picks up whatever was missed.

---

## 4. Transactions, and why they aren't used

MongoDB has multi-document transactions, but **only on a replica set**. A plain `mongod` on a
laptop cannot start one.

Three places would want one: deleting an account (secrets cascade, projects set null), deleting a
project (three child collections), and the migration. Requiring a replica set to delete an
account would be a strange tax on running this at all, so the operations are **ordered to make
partial failure recoverable** instead: children first, parent last.

- Crash after deleting a project's logs → the project is still there, retry works.
- Delete the project first and crash → orphaned documents, invisible to the UI, still in the
  database.

Recoverable beats atomic when atomic costs the ability to run locally. On a replica set, wrapping
`deleteProject` and `deleteAccount` in a session would be a small, contained change — and the
ordering stays correct either way.

---

## 5. Auth, which had no counterpart to port

Supabase Auth provided Google OAuth, email/password, JWT issuance and refresh, `auth.users`, and
the cookie-refresh dance in `lib/supabase/middleware.ts`. None of it survives a move to MongoDB,
so `src/auth/` is the one security-relevant code here that isn't a port of something already
reviewed. The choices, stated rather than implied:

**scrypt, not Argon2id.** Argon2id is the fashionable answer and a fine one, but it means a
native module in a credentials vault. scrypt is memory-hard, in the standard library, and
already the KDF this codebase uses for the vault PIN. One KDF, no new dependency, no build step
that can fail on a different architecture.

**N = 2^16 for passwords, 2^17 for the PIN.** Deliberately different. A PIN has ~20 bits of
entropy and the KDF is the only thing between a leaked database and a complete break, so it is
tuned as high as a serverless function can bear. A password is longer and the cost is paid on
every login, where ~100 ms is the budget before sign-in feels broken.

**Self-describing hashes** (`scrypt$N$r$p$salt$hash`), so raising the cost later doesn't
invalidate existing hashes — `needsRehash` flags old ones and login upgrades them in place.

**Opaque session tokens, not JWTs.** A JWT would save one indexed lookup per request. That is
the only thing it would save, and it cannot be revoked before it expires — which for a tool
holding provider credentials and a vault is the wrong trade. "Sign out everywhere" has to mean
it. Only the token's SHA-256 is stored, the same pattern the vault already used for its own
sessions.

**Login is constant-ish time and non-enumerating.** One message for every failure, and the hash
is computed even when no account matched. Both halves matter: a distinct "no such account" reply
turns the endpoint into a way to enumerate who has one, and returning early without hashing
leaks the same thing through timing instead of through prose.

**Google account linking requires a verified email.** An existing local account is matched on
email only when Google says the address is verified — otherwise anyone able to set an unverified
`email` claim could take over the account at that address. That is the classic OAuth linking
hole, and the test suite pins the three spellings Google uses for the flag.

**The `id_token` signature is not verified, and that is correct here.** The token does not arrive
from the browser; it comes back on our own HTTPS POST to Google's token endpoint, authenticated
with our client secret. TLS plus the fact that we made the request establishes provenance, and
Google's documentation says validation may be skipped for tokens obtained this way. A token
handed to us *by a client* would be a different situation needing full JWKS verification.

**Route guards are per route, not per router.** `router.use(requireUser)` runs for every request
that *enters* a router, including paths it doesn't serve — so with four routers sharing `/api`,
the first one's blanket guard rejected `/api/cron/sweep` and `/api/providers` before either
could fall through. This backend had that bug during development; the fix was to attach the
guard to each route, which makes mount order a readability question instead of a
security-relevant one, and makes a public route public on its face.

---

## 6. Data model notes

**Primary keys are UUID strings, not ObjectIds.** Not a style choice. Every secret is sealed
with AAD of `("keepstack/secret/v1", userId, kind, tier)`, and both wrapped copies of a user's
DEK are bound to their id the same way. The AAD is authenticated, so a ciphertext decrypts under
one user id and under no other. Reissuing ids during migration would make every credential
undecryptable noise and every vault PIN stop working — silently, with no way back. Since
migrated documents must hold UUIDs, new ones use them too: a collection with ObjectIds for some
rows and strings for others is a sorting and equality trap.

**Dates are BSON `Date`, not ISO strings.** Range queries, sorts and TTL indexes all need real
dates. Strings are produced only at the API boundary, by `src/http/serialize.ts`.

**Child documents carry `user_id`.** `ping_logs` and `usage_snapshots` had no owner column in
SQL — their policies joined through `projects`. Without a policy engine there is no join to lean
on, so the owner is denormalised onto the document and every query filters on it directly.

**`auth.users` + `profiles` became one document.** They were two tables because Supabase Auth
owned one of them, and migration 0003 had to mirror it with a `handle_new_user` trigger. Owning
identity here means there is nothing to keep in step.

**One honest API deviation.** `ping_logs.id`, `usage_snapshots.id` and `audit_log.id` were
Postgres `bigint`s and are typed `number` in `lib/registry/types.ts`; here they are UUID
strings. Nothing does arithmetic on them — they're React keys — but it is a difference, not a
coincidence. Every other field matches that file exactly, which is what makes the frontend's row
types the API contract whichever backend serves them.

**The serialisers are the secret boundary.** docs/SECURITY.md §6 forbids `select *` on the
secrets table. The schemaless equivalent is that `toSecretSummary` and `toCurrentUser` name
their fields explicitly and never spread the document, so `ciphertext`, `password_hash`,
`dek_pin`, `dek_srv` and `pin_salt` are absent by construction rather than by omission. Tests
assert the absence directly, including that the values themselves don't appear anywhere in the
serialised JSON.

---

## 7. What is deliberately absent

| Not here | Why |
| --- | --- |
| `claimLegacyRows()` and the claim banner | A one-time fix for Postgres rows that predated auth. The migration assigns ownership from the source registry instead, and unowned rows are reported and skipped rather than guessed at. |
| `schemaStatus()`, `forWrite()`, `vaultSchemaReady()`, `hasLegacyColumns()` | No hand-run migrations, so no window where code and schema disagree. §3. |
| `migratePlaintextKeys()` as a UI action | Folded into the migration script, which encrypts any remaining plaintext `anon_key` on the way across. |
| `/setup` page, `missingRegistryEnv()` | `GET /health` reports what is and isn't configured. |
| The Next.js middleware session refresh | Opaque server-side sessions have no token to refresh. |
| `vault_sessions` / `otp_challenges` migration | Ephemeral by design — a 10-minute sudo window and a 10-minute code. Sign in again. |

---

## 8. Verified

- `pnpm typecheck` — clean.
- `pnpm test` — 106 tests, 23 suites, 0 failures. 68 are the Next.js app's own crypto and
  provider suites, unedited but for import paths.
- End-to-end against a live MongoDB: signup → session cookie → account and project CRUD →
  adapter parsing of a pasted Supabase URL → unique-index 409 → enum rejection → PIN setup
  (weak PINs refused) → personal-tier write refused while locked → wrong-PIN counting → unlock →
  encrypt → reveal (exact round-trip, `no-store`) → lock → reveal refused. Confirmed in the
  database that the stored document holds only ciphertext and no plaintext.
- Cross-user isolation: a second user — signed in, with their **own** vault unlocked so no probe
  short-circuits on "locked" — sees zero projects, accounts, secrets and audit entries, and all
  **13** paths that take an id belonging to the first user return *"doesn't exist, or isn't
  yours"*: `GET`/`PATCH`/`DELETE` on the project, its logs, its usage, ping, keys, restore and
  connection strings, `PATCH`/`DELETE` on the account, and reveal and delete on the secret. The
  owner's project and secret were intact afterwards.

  Two of those initially answered 200 with an empty result instead of 404 — `/projects/:id/usage`
  (a scoped query legitimately returning `[]`) and `DELETE /vault/secrets/:id` (returning
  `{ok: false}`). Neither leaked anything, and the owner's data was untouched in both cases, but
  being the only project routes that answer 200 for an id they shouldn't recognise is how clients
  grow two code paths. Both now 404.
- Cascades: deleting a project removed its ping logs and secrets; deleting an account removed
  its secrets and set its projects' `account_id` to null, keeping the projects.
- Export carries no ciphertext and no secret values. The audit log records kind, tier and label
  and never a value.
- The sweep reports pings, usage reads and status checks as three separate counts, and the
  endpoint refuses a wrong or missing `CRON_SECRET`.

---

## 9. Running the frontend against either backend

The Next.js app can serve from either backend, chosen by one variable:

```bash
KEEPSTACK_BACKEND=node
KEEPSTACK_API_URL=http://127.0.0.1:4000
```

`pnpm dev --nodejs` sets both for one run and starts the two processes together.

### Where the switch lives, and why not at the call sites

The frontend never had an API to repoint. `app/page.tsx` calls `listProjects()` directly,
in-process, and identity comes from Supabase Auth cookies through `middleware.ts`. So "use a
different backend" had to become a real decision somewhere, and there were two places to put it:

- **At the call sites** — ~36 of them across the pages and server actions. Every one would grow
  an `if`, and every new feature would have to remember to.
- **Inside the data layer** — `listProjects()` itself decides. The call sites don't change at
  all, and a new page gets the switch for free because it calls the same function.

The second, obviously. Each exported read in `lib/registry/queries.ts`, `lib/vault/*` and
`lib/usage.ts` now begins with `if (usingNodeBackend()) return api.…`, and the write paths in
the server actions do the same. The signatures didn't change, which is why the diff to the UI
is almost nil.

That works because of a decision made earlier: `backend-node/src/http/serialize.ts` emits
exactly the shapes in `lib/registry/types.ts`, field for field. Those types are the contract
both backends satisfy, so the same components render either one's data without knowing which
answered.

### Next.js as a backend-for-frontend

The browser only ever talks to Next.js; Next.js talks to the API. Worth stating because of what
it removes. Letting the browser call the API directly would need CORS with an origin allowlist,
`SameSite=None` cookies, and therefore HTTPS in development. Proxying instead means the API can
stay bound to loopback, unreachable from anywhere else, and the session cookie is an ordinary
same-site cookie on the Next.js origin.

`lib/backend/client.ts` carries two things across that boundary: the browser's `ks_session` and
`ks_vault` cookies on the way out, and any `Set-Cookie` on the way back — re-issued for the
Next.js origin, because a cookie scoped to the API's host would be dropped. Only those two
names are relayed; a backend that started setting some other cookie can't plant it through the
proxy.

### The three things that differ

1. **Google sign-in is hidden on the Node backend.** Its OAuth flow sets a session cookie on the
   API's own host, so a browser that only talks to Next.js completes the consent screen and
   lands back signed out. Proxying the whole flow would mean implementing the redirect, state
   and token exchange a second time in Next.js — a feature, not a shim — so the button is hidden
   rather than left to fail. Email and password work normally, and Google works against the API
   directly for a client that doesn't use this proxy.

2. **The migration banners don't appear.** `schemaStatus()`, `vaultSchemaReady()`,
   `claimAvailable()` and `keyMigrationStatus()` all answer questions about hand-run SQL and
   pre-auth rows. On the Node backend each returns "not applicable" rather than a reassuring
   tick for a question that makes no sense there — §3 and §7.

3. **The Next.js cron route answers 501.** It sweeps the Supabase registry; on the Node backend
   the sweep belongs to that service. Running it would fail with something about a missing
   Supabase variable, and — worse — a schedule left pointing at the old URL would look like it
   was working.

### Verified

Both backends, same build:

- `pnpm dev --nodejs`, then signing up through the API and using that session against Next.js:
  the dashboard, accounts, project detail, vault and new-project pages all render **200** with
  MongoDB data — project names, account labels, the signed-in user's name, stored credential
  kinds and labels, and the audit trail. No secret *value* appears in any rendered page.
- Middleware: an unauthenticated `/` redirects to `/login`; a signed-in `/login` redirects to
  `/`.
- `pnpm dev` (default): `/login` renders, `/` redirects to `/login`, Supabase session handling
  unchanged.
- All three flag spellings resolve correctly — `pnpm dev`, `pnpm dev --nodejs` (argv) and
  `npm run dev --nodejs` (which npm turns into `npm_config_nodejs`, never reaching argv).
