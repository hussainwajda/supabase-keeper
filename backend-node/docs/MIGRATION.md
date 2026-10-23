# Moving your registry to MongoDB

Copies your accounts, projects, secrets, ping history and audit trail out of Supabase and into
MongoDB, **keeping your vault PIN working and every stored credential decryptable.**

Re-runnable, and it has a `--dry-run`. Nothing in your Supabase project is modified or deleted —
the migration only reads.

---

## The one thing that must not be got wrong

**Use the same `KEEPSTACK_MASTER_KEY` and `KEEPSTACK_PIN_PEPPER` your Supabase deployment uses.**

Ciphertexts move across byte for byte. They are AES-256-GCM envelopes, and the additional
authenticated data includes the user's id, the secret's kind and its tier:

```
aad("keepstack/secret/v1", userId, kind, tier)     lib/crypto/secrets.ts
aad("keepstack/dek-pin/v1", userId)                lib/crypto/dek.ts
aad("keepstack/dek-srv/v1", userId)
```

The AAD is authenticated, so an envelope opens under one key and one user id — and under no
other. Three consequences:

- A **different `KEEPSTACK_MASTER_KEY`** makes every server-tier secret (provider API keys, anon
  keys, REST tokens) permanently unreadable.
- A **different `KEEPSTACK_PIN_PEPPER`** makes every vault PIN stop working, because the pepper
  is mixed into the key that unwraps the DEK.
- A **reissued user id** breaks both at once.

Which is why the migration preserves primary keys rather than minting new ones. Your user keeps
its UUID, so `dek_pin` still unwraps with the PIN you already know and `dek_srv` still unwraps
with the master key.

There is no "re-encrypt everything" fallback for personal-tier secrets, by design: the server
cannot read them without your PIN, which is the whole point of that tier. Get the keys right.

---

## Before you start

Take an export. It is the safety net that exists precisely so this step can't cost you
anything:

```bash
# From the running Next.js app, signed in:
curl -b 'your-session-cookies' https://your-keepstack/api/export > keepstack-backup.json

# And the database itself:
supabase db dump --data-only > keepstack-backup.sql
```

The JSON export deliberately excludes secrets, so it is safe to keep on disk. The SQL dump is
not — it contains the ciphertexts. Treat it accordingly.

---

## Step by step

### 1. Configure this backend

```bash
cd backend-node
pnpm install
cp .env.example .env
```

In `.env`:

```bash
MONGODB_URI=mongodb://127.0.0.1:27017        # or your Atlas mongodb+srv:// string
MONGODB_DB=keepstack

# THE SAME VALUES your Supabase deployment uses. Copy them from Vercel, not from openssl.
KEEPSTACK_MASTER_KEY=<the existing one>
KEEPSTACK_PIN_PEPPER=<the existing one>

# Read-only, and only for the migration. Delete both when you're done.
SUPABASE_URL=https://xxxxxxxxxxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

The **service role** key is required rather than the anon key: the migration has to read
`auth.users` through the Admin API and every row regardless of RLS.

### 2. Dry run

```bash
pnpm migrate -- --dry-run
```

```
Migrating https://xxxx.supabase.co -> MongoDB  (dry run)

Would migrate:
  users           1
  accounts        5
  projects        11
  secrets         14
  ping logs       1203
  usage snapshots 88
  audit entries   42
```

Check the counts against what you expect. Anything reported as `skipped (no owner)` is a row
that predates sign-in and has `user_id = null` — the migration will not guess an owner for it.
If you have such rows, claim them in the Next.js app first (the "Claim these rows" banner), then
re-run.

### 3. Migrate

```bash
pnpm migrate
```

### 4. Give yourself a password

Supabase Auth stored a bcrypt hash that this backend deliberately doesn't try to read or verify,
so a migrated account arrives with no password. Either:

```bash
pnpm set-password -- you@example.com
```

…or configure `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and sign in with Google — the account
is matched on your verified email address and linked.

### 5. Check it

```bash
pnpm start
curl localhost:4000/health
```

```bash
curl -c jar -X POST localhost:4000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"…"}'

curl -b jar localhost:4000/api/projects | head
```

Then the thing actually worth checking — that the vault came across:

```bash
# Your existing PIN should unlock it.
curl -c jar -b jar -X POST localhost:4000/api/vault/unlock/pin \
  -H 'Content-Type: application/json' -d '{"pin":"<your existing PIN>"}'

# And an existing secret should still decrypt.
curl -b jar localhost:4000/api/vault/secrets
curl -c jar -b jar -X POST localhost:4000/api/vault/secrets/<id>/reveal
```

If the unlock fails, `KEEPSTACK_PIN_PEPPER` doesn't match. If the unlock works but a reveal
returns *"can't be decrypted with the current keys"*, `KEEPSTACK_MASTER_KEY` doesn't match for a
server-tier secret. Both are fixable — correct the value and try again; nothing has been
destroyed.

### 6. Tidy up

Remove `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from `.env`. They were only ever needed
for the migration, and a service-role key sitting in a file is a service-role key that can leak.

Keep the Supabase project until you're confident. The migration didn't touch it.

---

## What moves, and what doesn't

| Source | Destination | Note |
| --- | --- | --- |
| `auth.users` + `profiles` | `users` | Merged. Vault fields (`pin_salt`, `dek_pin`, `dek_srv`) carried across |
| `accounts` | `accounts` | Rows with no owner are skipped and reported |
| `projects` | `projects` | `external_id` falls back to the legacy `ref`; `ping_table` folded into `metadata` |
| `secrets` | `secrets` | Ciphertext byte for byte, no decrypt, no re-encrypt |
| `projects.anon_key` (if plaintext) | `secrets` | Encrypted on the way across |
| `ping_logs` | `ping_logs` | `user_id` derived from the parent project; original id kept as `legacy_id` |
| `usage_snapshots` | `usage_snapshots` | Keyed on `(project, metric, captured_on)` |
| `audit_log` | `audit_log` | |
| `vault_sessions`, `otp_challenges` | — | Ephemeral by design. Sign in again |
| Supabase password hashes | — | bcrypt, not read. See step 4 |

A registry that never ran migrations 0002 or 0006 still migrates: reads fall back to the old
column names exactly as `normalizeProject()` does, and a table that doesn't exist is reported as
having nothing to move rather than failing the run.

Plaintext `anon_key` values get encrypted into proper server-tier secrets during the migration —
the job `lib/vault/migrate-keys.ts` did in the Next.js app. If `KEEPSTACK_MASTER_KEY` isn't set,
the script **warns loudly and skips them** rather than silently dropping them.

---

## Rolling back

There is nothing to roll back. The migration only reads from Supabase, so your Next.js
deployment keeps working throughout and after. If you want to start the MongoDB side over:

```js
// mongosh
use keepstack
db.dropDatabase()
```

…then re-run `pnpm migrate`. Or just correct a key and re-run — every write is an upsert keyed
on the original primary key, so a second run fixes a partial first one instead of duplicating
it.

---

## Running both at once

They can share nothing and coexist indefinitely: separate databases, separate sign-ins, the same
provider adapters. Useful while you decide, and the reason this backend is `optional` rather
than a replacement.

The one thing to **avoid** is both sweeping the same projects on a schedule. It wouldn't corrupt
anything — pings are idempotent and each registry keeps its own `last_pinged_at` — but you'd
spend two pings where one was needed, which for Upstash's monthly command budget is a real
cost. Turn off the Vercel cron (`vercel.json`) or leave `ENABLE_SCHEDULER` unset and
`CRON_SECRET` absent here, whichever side you aren't using.
