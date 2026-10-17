-- Keepstack 0007 — usage tracking for `watch` providers (Phase 4)
--
-- Run this in the SQL editor of your REGISTRY Supabase project. Safe at any point after 0003;
-- it only adds a table.
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
  captured_at  timestamptz not null default now()
);

create index if not exists usage_snapshots_project_metric_idx
  on public.usage_snapshots (project_id, metric, captured_at desc);

-- One snapshot per project/metric/day keeps the table small and makes the daily sweep
-- idempotent: re-running it overwrites the day rather than stacking duplicate rows.
create unique index if not exists usage_snapshots_daily_idx
  on public.usage_snapshots (project_id, metric, (captured_at::date));

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
