-- Keepstack 0002 — multi-provider groundwork (Phase 0)
--
-- Additive and idempotent. After this runs the existing app still works unchanged: every new
-- column either has a default or is nullable, and `ref` / `anon_key` are left in place.
--
-- Run this in the SQL editor of your REGISTRY Supabase project.
-- Take an export first (Dashboard → Export JSON, or `supabase db dump --data-only`).

-- 1. The provider enum. Adding a provider later is a migration on purpose: it forces the
--    docs/PROVIDERS.md update to happen in the same commit.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'provider_id') then
    create type public.provider_id as enum ('supabase', 'neon', 'mongodb', 'upstash', 'appwrite');
  end if;
end $$;

-- 2. Accounts gain a provider. Everything that exists today is Supabase.
alter table public.accounts
  add column if not exists provider       public.provider_id not null default 'supabase',
  add column if not exists last_synced_at  timestamptz,
  add column if not exists last_sync_status text,
  add column if not exists last_sync_error  text;

-- 3. Projects gain a provider, a generic external id, and normalised lifecycle fields.
alter table public.projects
  add column if not exists provider        public.provider_id not null default 'supabase',
  add column if not exists external_id     text,
  add column if not exists metadata        jsonb not null default '{}'::jsonb,
  add column if not exists provider_status text,
  add column if not exists lifecycle       text not null default 'unknown',
  add column if not exists strategy        text not null default 'ping',
  add column if not exists region          text,
  add column if not exists plan            text,
  add column if not exists discovered_at   timestamptz;

-- Backfill external_id from the Supabase-specific `ref` column.
update public.projects
   set external_id = ref
 where external_id is null
   and ref is not null;

-- Move the Supabase-only ping_table into metadata, where per-provider config now lives.
-- `ping_table` stays as a column until migration 0006 so Phase 0 code keeps reading it.
update public.projects
   set metadata = metadata || jsonb_build_object('ping_table', ping_table)
 where ping_table is not null
   and not (metadata ? 'ping_table');

-- Seed lifecycle from whatever the last ping told us.
update public.projects
   set lifecycle = case
     when last_status = 'ok' then 'active'
     when last_error ilike '%paused%' then 'paused'
     when last_status = 'error' then 'unknown'
     else 'unknown'
   end
 where lifecycle = 'unknown';

-- external_id is required from here on, and unique per provider rather than globally.
-- (The old schema had `ref text not null unique`, which would reject a Neon project that
--  happened to share a string with a Supabase ref.)
do $$
declare
  orphans int;
begin
  select count(*) into orphans from public.projects where external_id is null;
  if orphans > 0 then
    raise exception
      'Cannot set external_id NOT NULL: % project row(s) have neither external_id nor ref. Fix or delete them, then re-run.',
      orphans;
  end if;
end $$;

alter table public.projects
  alter column external_id set not null;

alter table public.projects
  alter column ref drop not null;

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'projects_ref_key' and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects drop constraint projects_ref_key;
  end if;
end $$;

create unique index if not exists projects_provider_external_id_idx
  on public.projects (provider, external_id);

alter table public.projects drop constraint if exists projects_lifecycle_check;
alter table public.projects
  add constraint projects_lifecycle_check
  check (lifecycle in ('active', 'idle', 'paused', 'archived', 'deleted', 'unknown'));

alter table public.projects drop constraint if exists projects_strategy_check;
alter table public.projects
  add constraint projects_strategy_check
  check (strategy in ('ping', 'watch', 'alert_only'));

-- interval_days was capped at 30. MongoDB Atlas allows a 30-day idle window, so a 20-day
-- interval is normal there and Turso-style providers may want more headroom.
alter table public.projects
  drop constraint if exists projects_interval_days_check;
alter table public.projects
  add constraint projects_interval_days_check check (interval_days between 1 and 60);

-- 4. Ping logs record which strategy ran, so history stays interpretable after a provider
--    changes its rules (or after a project moves from `ping` to `alert_only`).
alter table public.ping_logs
  add column if not exists strategy text not null default 'ping',
  add column if not exists via      text;

create index if not exists projects_provider_idx on public.projects (provider);
create index if not exists projects_lifecycle_idx on public.projects (lifecycle);
create index if not exists accounts_provider_idx on public.accounts (provider);

-- 5. RLS stays enabled with no policies: only the service role reaches these tables until
--    Phase 1 introduces real users and per-user policies.
alter table public.accounts  enable row level security;
alter table public.projects  enable row level security;
alter table public.ping_logs enable row level security;
