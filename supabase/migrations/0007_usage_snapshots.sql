-- Keepstack 0007 — usage tracking for `watch` providers (Phase 4)
--
-- Run this in the SQL editor of your REGISTRY Supabase project. Safe at any point after 0003;
-- it only adds a table. Safe to re-run.
--
-- Neon is the first provider that can't be kept alive by pinging: it never pauses for being
-- idle, but exhausting its 100 compute-hours per project per month suspends the compute. The
-- useful signal is therefore a trend, not a single reading — hence an append-only table rather
-- than a column on `projects`.

create table if not exists public.usage_snapshots (
  id           bigint generated always as identity primary key,
  project_id   uuid not null references public.projects on delete cascade,
  -- 'compute_cu_hours' | 'storage_bytes' | 'transfer_bytes' | 'commands' | 'rows_read' ...
  metric       text not null,
  value        numeric not null,
  -- The plan's ceiling, when the provider reports one. Null means "no known limit".
  limit_value  numeric,
  unit         text not null default '',
  period_start timestamptz,
  period_end   timestamptz,
  captured_at  timestamptz not null default now(),
  /*
    The UTC day of the reading, written by the application.

    Two things it deliberately is NOT:

    - Not a unique index on `(captured_at::date)`. That would be an EXPRESSION index, and
      `ON CONFLICT (project_id, metric, captured_at::date)` can't be expressed through
      PostgREST's `on_conflict` parameter — the upsert fails with 42P10, "no unique or
      exclusion constraint matching the ON CONFLICT specification".

    - Not a generated column. `captured_at::date` reads the session TimeZone, so it isn't
      immutable and Postgres rejects it with 42P17. Pinning the zone
      (`(captured_at AT TIME ZONE 'UTC')::date`) does satisfy that, but only one function in
      the codebase ever writes this table, so a plain column the app fills is simpler and
      carries no volatility question at all.
  */
  captured_on  date not null default ((now() AT TIME ZONE 'UTC')::date)
);

-- Bring an older partially-applied copy of this table into line.
alter table public.usage_snapshots
  add column if not exists captured_on date not null default ((now() AT TIME ZONE 'UTC')::date);

create index if not exists usage_snapshots_project_metric_idx
  on public.usage_snapshots (project_id, metric, captured_at desc);

-- One snapshot per project/metric/day keeps the table small and makes the daily sweep
-- idempotent: re-running it replaces the day's reading rather than stacking duplicate rows.
-- Plain columns, so the upsert can name them as its conflict target.
create unique index if not exists usage_snapshots_daily_idx
  on public.usage_snapshots (project_id, metric, captured_on);

alter table public.usage_snapshots enable row level security;

-- Reachable through the project that owns it, same shape as ping_logs.
drop policy if exists "usage_snapshots: via own project" on public.usage_snapshots;
create policy "usage_snapshots: via own project" on public.usage_snapshots
  for all to authenticated
  using (
    exists (
      select 1 from public.projects p
       where p.id = usage_snapshots.project_id
         and p.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.projects p
       where p.id = usage_snapshots.project_id
         and p.user_id = (select auth.uid())
    )
  );
