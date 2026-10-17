// Same as supabase/keep_alive.sql — shown in the UI so you can copy it into each project.
// Only needed for Supabase projects without a personal access token; with a PAT, Keepstack
// pings via the Management API and needs no table (Phase 3).
export const KEEP_ALIVE_SQL = `create table if not exists public.keep_alive (
  id int primary key default 1,
  note text default 'pinged by keepstack'
);
insert into public.keep_alive (id) values (1) on conflict do nothing;
alter table public.keep_alive enable row level security;
drop policy if exists "keep_alive readable" on public.keep_alive;
create policy "keep_alive readable" on public.keep_alive for select to anon using (true);`;
