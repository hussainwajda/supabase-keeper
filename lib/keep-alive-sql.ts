// Same as supabase/keep_alive.sql — shown in the UI so you can copy it into each project.
export const KEEP_ALIVE_SQL = `create table if not exists public.keep_alive (
  id int primary key default 1,
  note text default 'pinged by supabase-keeper'
);
insert into public.keep_alive (id) values (1) on conflict do nothing;
alter table public.keep_alive enable row level security;
drop policy if exists "keep_alive readable" on public.keep_alive;
create policy "keep_alive readable" on public.keep_alive for select to anon using (true);`;
