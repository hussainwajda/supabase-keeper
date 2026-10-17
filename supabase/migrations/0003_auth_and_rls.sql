-- Keepstack 0003 — real users, and row level security (Phase 1)
--
-- Run this in the SQL editor of your REGISTRY Supabase project, after 0002.
--
-- IMPORTANT, read before running: this turns on RLS with per-user policies. Rows created
-- before sign-in existed have `user_id = null`, and a null-owned row matches no policy, so
-- immediately after this migration the dashboard will show zero projects.
--
-- That is expected. Sign in with Google, then use the "Claim these rows" banner on the
-- dashboard to take ownership of them. Run 0004 afterwards to make `user_id` mandatory.
--
-- Nothing is deleted at any point. Export your registry first if you want a copy.

-- 1. Profiles — one row per auth user, and where the vault keys land in Phase 2.
create table if not exists public.profiles (
  id                   uuid primary key references auth.users on delete cascade,
  display_name         text,
  avatar_url           text,
  -- Vault columns are created here but stay null until Phase 2. See docs/SECURITY.md §2.
  -- `text` rather than `bytea`: these hold base64 envelopes produced by lib/crypto/aead.ts.
  -- PostgREST represents bytea as `\x…` hex over JSON, which is an extra encoding layer to
  -- get wrong in both directions for no benefit at these sizes.
  vault_initialized_at timestamptz,
  pin_salt             text,
  dek_pin              text,
  dek_srv              text,
  pin_failed_attempts  int not null default 0,
  pin_locked_until     timestamptz,
  created_at           timestamptz not null default now()
);

-- Keep a profile in step with auth.users automatically, so no code path can forget to.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', new.email),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for anyone who signed up before this migration.
insert into public.profiles (id, display_name)
select u.id, coalesce(u.raw_user_meta_data ->> 'full_name', u.email)
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id);

-- 2. Ownership. Nullable for now; 0004 enforces NOT NULL once legacy rows are claimed.
alter table public.accounts add column if not exists user_id uuid references auth.users on delete cascade;
alter table public.projects add column if not exists user_id uuid references auth.users on delete cascade;

create index if not exists accounts_user_idx on public.accounts (user_id);
create index if not exists projects_user_idx on public.projects (user_id);

-- Uniqueness becomes per-user: two people may each register the same public project ref.
drop index if exists projects_provider_external_id_idx;
create unique index if not exists projects_user_provider_external_id_idx
  on public.projects (user_id, provider, external_id);

create unique index if not exists accounts_user_provider_email_idx
  on public.accounts (user_id, provider, email);

-- 3. Audit log. Records that something happened, never the value of a secret.
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users on delete cascade,
  action      text not null,
  target_type text,
  target_id   uuid,
  method      text,
  ip          inet,
  user_agent  text,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_user_idx on public.audit_log (user_id, created_at desc);

-- 4. RLS. Every table is scoped to the signed-in user.
--    The service role bypasses all of this and is used only by the nightly sweep and the
--    one-time legacy claim.

alter table public.profiles  enable row level security;
alter table public.accounts  enable row level security;
alter table public.projects  enable row level security;
alter table public.ping_logs enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists "profiles: self" on public.profiles;
create policy "profiles: self" on public.profiles
  for all to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "accounts: own" on public.accounts;
create policy "accounts: own" on public.accounts
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "projects: own" on public.projects;
create policy "projects: own" on public.projects
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Ping logs are reachable through the project that owns them.
drop policy if exists "ping_logs: via own project" on public.ping_logs;
create policy "ping_logs: via own project" on public.ping_logs
  for all to authenticated
  using (
    exists (
      select 1 from public.projects p
       where p.id = ping_logs.project_id
         and p.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.projects p
       where p.id = ping_logs.project_id
         and p.user_id = (select auth.uid())
    )
  );

-- The audit log is append-only from the user's side: readable, never editable.
drop policy if exists "audit_log: read own" on public.audit_log;
create policy "audit_log: read own" on public.audit_log
  for select to authenticated
  using (user_id = (select auth.uid()));
