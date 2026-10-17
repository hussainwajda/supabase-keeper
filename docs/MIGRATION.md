# Migration order

Keepstack's setup **interleaves SQL migrations with app-side steps**. Four migrations can be run
straight away; two must wait, because they verify work that only the running app can do.

Running them out of order is safe — `0004` and `0006` refuse rather than destroying anything — but
it's confusing, so here is the whole sequence in one place.

## The order

| Step | What | Where | Notes |
| --- | --- | --- | --- |
| 1 | `0001_initial.sql` | SQL editor | Base tables |
| 2 | `0002_multi_provider.sql` | SQL editor | Multi-provider columns |
| 3 | `0003_auth_and_rls.sql` | SQL editor | Profiles, ownership, **RLS on** |
| 4 | `0005_vault.sql` | SQL editor | Vault tables |
| 4b | `0007_usage_snapshots.sql` | SQL editor | Usage tracking for `watch` providers (Neon) |
| 5 | **Environment** | `.env.local` / Vercel | `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `KEEPSTACK_MASTER_KEY`, `KEEPSTACK_PIN_PEPPER` |
| 6 | **Sign in** | the app | Google, or email + password |
| 7 | **Claim your rows** | dashboard banner | Needs `KEEPSTACK_ALLOW_LEGACY_CLAIM=true` |
| 8 | `0004_require_owner.sql` | SQL editor | ⚠️ Verifies step 7 |
| 9 | **Set a vault PIN** | `/vault` | |
| 10 | **Encrypt saved keys** | dashboard banner | Needs steps 6, 7 and 9 |
| 11 | `0006_drop_plaintext_keys.sql` | SQL editor | ⚠️ Verifies step 10 |

Steps 8 and 11 are the ones that wait. Everything from step 5 onward is blocked by the anon key,
so if the app is showing you the `/setup` page, that is the only thing to fix.

## Why two migrations can't run early

**`0004_require_owner.sql`** makes `user_id` mandatory. Rows created before Keepstack had sign-in
have no owner, so the column can't be `NOT NULL` until they've been claimed — and claiming needs a
signed-in user to assign them to.

**`0006_drop_plaintext_keys.sql`** drops `projects.anon_key`. Those values have to be moved into
the encrypted `secrets` table first, and **that can't be a SQL migration**: encrypting needs
`KEEPSTACK_MASTER_KEY`, which lives in the application environment and deliberately never reaches
the database. So the app does the move, and this migration only verifies and cleans up.

Both refuse to run while their precondition is unmet, and both are safe to attempt early — a
failed attempt changes nothing.

## Nothing is urgent

If you stop after step 7, or after step 10, the app works:

- **Unowned rows** are hidden by RLS, which is why the dashboard looks empty until you claim. The
  claim banner says so.
- **Plaintext keys** keep working — the keep-alive sweep reads the encrypted secret first and falls
  back to the legacy column, so pings carry on either way.
- **No vault PIN** means the credential panels stay hidden and nothing personal can be stored yet.
  Everything else is unaffected.

You can leave `0004` and `0006` for a later session. They're hygiene, not function.

## Fresh install

A new deployment with no pre-existing data skips the awkward parts: run `0001`, `0002`, `0003`,
`0005`, set the environment, sign in, set a PIN, then run `0004` and `0006` immediately — there is
nothing to claim and nothing to encrypt, so both pass straight away.

## Before you start

Take a copy. The **Export JSON** button on the dashboard writes accounts, projects and ping logs
to a file (secrets are deliberately excluded, so it's safe to keep on disk). Or, with the Supabase
CLI:

```bash
supabase db dump --data-only -f keepstack-backup.sql
```

And back up `KEEPSTACK_MASTER_KEY` to a password manager **before** step 10. Once keys are
encrypted with it, losing it makes them unrecoverable.

## Checking where you are

Run this in the SQL editor:

```sql
select
  (select count(*) from auth.users)                                    as users,
  (select count(*) from public.accounts where user_id is null)         as unclaimed_accounts,
  (select count(*) from public.projects where user_id is null)         as unclaimed_projects,
  (select count(*) from public.profiles where dek_pin is not null)     as vault_pins_set,
  (select count(*) from public.projects where anon_key is not null)    as plaintext_keys,
  (select count(*) from public.secrets)                               as encrypted_secrets;
```

- `unclaimed_* > 0` → do step 7 before `0004`
- `plaintext_keys > 0` → do step 10 before `0006`
- `vault_pins_set = 0` → do step 9 before step 10

If the query errors on a missing column or table, the SQL migration that creates it hasn't run yet.
