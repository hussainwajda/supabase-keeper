-- Keepstack 0005 — the encrypted vault (Phase 2)
--
-- Run this in the SQL editor of your REGISTRY Supabase project, after 0003.
-- (0004 can be run before or after this one; they don't interact.)
--
-- Creates the tables. It does NOT move your existing plaintext anon keys — that needs the
-- encryption key, so it's done by the app: a one-time "Encrypt saved keys" banner appears on
-- the dashboard. Migration 0006 then drops the plaintext column, and refuses to run until
-- every key has been moved.
--
-- Requires KEEPSTACK_MASTER_KEY and KEEPSTACK_PIN_PEPPER in the environment first, or the
-- app will tell you the vault is misconfigured rather than silently storing anything.

-- Defensive: if 0003 was run before the bytea -> text change, bring the columns into line.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles'
       and column_name = 'dek_pin' and data_type = 'bytea'
  ) then
    alter table public.profiles
      alter column pin_salt type text using encode(pin_salt, 'base64'),
      alter column dek_pin  type text using encode(dek_pin,  'base64'),
      alter column dek_srv  type text using encode(dek_srv,  'base64');
  end if;
end $$;

-- 1. Secrets. One table, polymorphic owner: a secret belongs to an account or a project.
create table if not exists public.secrets (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  account_id      uuid references public.accounts on delete cascade,
  project_id      uuid references public.projects on delete cascade,
  -- 'account_password' | 'pat' | 'api_key' | 'api_email' | 'service_account'
  -- | 'db_password' | 'anon_key' | 'connection_string' | 'rest_token'
  kind            text not null,
  label           text,
  -- 'server'   = the nightly sweep can decrypt it unattended (KEEPSTACK_MASTER_KEY)
  -- 'personal' = only the user, after a PIN or OTP unlock (their DEK)
  tier            text not null check (tier in ('server', 'personal')),
  -- base64 envelope: [version:1][iv:12][ciphertext][gcm tag:16]
  ciphertext      text not null,
  key_version     int not null default 1,
  last_used_at    timestamptz,
  last_verified_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint secrets_has_owner check (account_id is not null or project_id is not null)
);

create index if not exists secrets_user_idx on public.secrets (user_id);
create index if not exists secrets_account_idx on public.secrets (account_id);
create index if not exists secrets_project_idx on public.secrets (project_id);

-- One secret of a given kind per owner, so "update the PAT" is unambiguous.
create unique index if not exists secrets_account_kind_idx
  on public.secrets (account_id, kind) where account_id is not null;
create unique index if not exists secrets_project_kind_idx
  on public.secrets (project_id, kind) where project_id is not null;

-- 2. Vault sessions — sudo mode, 10 minutes.
--    `dek_sealed` is the user's DEK encrypted under a key derived from the raw session token,
--    which exists only in their httpOnly cookie. A database snapshot alone cannot unseal it.
create table if not exists public.vault_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  token_hash text not null unique,
  dek_sealed text not null,
  method     text not null check (method in ('pin', 'otp')),
  ip         inet,
  user_agent text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists vault_sessions_user_idx on public.vault_sessions (user_id);
create index if not exists vault_sessions_expiry_idx on public.vault_sessions (expires_at);

-- 3. One-time codes emailed for vault unlock and PIN reset. Only the hash is stored.
create table if not exists public.otp_challenges (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  code_hash   text not null,
  purpose     text not null check (purpose in ('vault_unlock', 'pin_reset')),
  attempts    int not null default 0,
  consumed_at timestamptz,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists otp_challenges_user_idx on public.otp_challenges (user_id, created_at desc);

-- 4. RLS.
--
-- `secrets` is deliberately the strictest table in the schema: the user may list and manage
-- their own rows (the inventory UI needs that), but note that reading `ciphertext` is useless
-- without a key the database does not contain.
--
-- `vault_sessions` and `otp_challenges` get NO user-facing policies at all. They are written
-- and read only by server-side vault code via the service role. A client that could update
-- its own session row could extend its own sudo window or swap in another sealed DEK.

alter table public.secrets        enable row level security;
alter table public.vault_sessions enable row level security;
alter table public.otp_challenges enable row level security;

drop policy if exists "secrets: own" on public.secrets;
create policy "secrets: own" on public.secrets
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 5. Keep `updated_at` honest.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists secrets_touch_updated_at on public.secrets;
create trigger secrets_touch_updated_at
  before update on public.secrets
  for each row execute function public.touch_updated_at();

-- 6. Audit actions this phase introduces, for reference (no schema change needed):
--    vault.pin_set, vault.pin_changed, vault.pin_reset, vault.unlock, vault.unlock_failed,
--    vault.locked_out, vault.otp_sent, vault.recovery_disabled,
--    secret.create, secret.update, secret.delete, secret.reveal, secret.migrated
