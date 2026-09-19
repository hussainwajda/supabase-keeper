-- Run this in the SQL editor of your REGISTRY Supabase project.

create table if not exists public.accounts (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  label        text,
  login_method text,            -- e.g. GitHub, Google, Email + password
  notes        text,
  created_at   timestamptz not null default now()
);

create table if not exists public.projects (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid references public.accounts(id) on delete set null,
  name           text not null,
  ref            text not null unique,      -- the 20-char project ref (xxxx.supabase.co)
  anon_key       text,                      -- anon / publishable key ONLY (never service_role)
  ping_table     text default 'keep_alive',
  keep_alive     boolean not null default true,
  interval_days  int not null default 5 check (interval_days between 1 and 30),
  repo_url       text,
  local_path     text,
  notes          text,
  last_pinged_at timestamptz,
  last_status    text,                      -- 'ok' | 'error'
  last_error     text,
  created_at     timestamptz not null default now()
);

create table if not exists public.ping_logs (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references public.projects(id) on delete cascade,
  status      text not null,
  http_status int,
  duration_ms int,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists ping_logs_project_idx on public.ping_logs (project_id, created_at desc);

-- Lock everything down: only the service role (used server-side by the app) can read/write.
alter table public.accounts  enable row level security;
alter table public.projects  enable row level security;
alter table public.ping_logs enable row level security;
