-- Run this ONCE in EACH project you want kept alive.
-- It gives the pinger a tiny table it can read with the anon key, so every ping is a real DB query.
create table if not exists public.keep_alive (
  id int primary key default 1,
  note text default 'pinged by keepstack'
);
insert into public.keep_alive (id) values (1) on conflict do nothing;
alter table public.keep_alive enable row level security;
drop policy if exists "keep_alive readable" on public.keep_alive;
create policy "keep_alive readable" on public.keep_alive for select to anon using (true);
