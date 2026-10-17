-- Keepstack 0006 — drop the plaintext key column (Phase 2, run LAST)
--
-- Run this only after the dashboard's "Encrypt saved keys" banner is gone, i.e. every anon
-- key has been moved into the encrypted `secrets` table. It refuses to run otherwise, so it
-- is safe to try early.
--
-- This also retires the Supabase-only columns that the multi-provider model replaced:
--   ref        -> external_id   (migration 0002)
--   ping_table -> metadata->>'ping_table'
--
-- Irreversible. Export your registry first if you want a record of the old shape.

do $$
declare
  remaining int;
begin
  select count(*) into remaining from public.projects where anon_key is not null;
  if remaining > 0 then
    raise exception
      'Still unencrypted: % project(s) hold a plaintext anon_key.'
      '  This is the LAST migration — it needs app-side steps done first:'
      '  (1) set NEXT_PUBLIC_SUPABASE_ANON_KEY, (2) sign in, (3) claim your rows,'
      '  (4) set a vault PIN on /vault, (5) press "Encrypt saved keys" on the dashboard.'
      '  Then re-run this. Nothing is broken in the meantime: the keep-alive sweep reads'
      '  plaintext keys as a fallback, so you can leave this migration until later.',
      remaining;
  end if;
end $$;

-- Belt and braces: make sure nothing is silently lost if a ping_table value never made it
-- into metadata (0002 backfilled these, but a row added in between could have missed it).
update public.projects
   set metadata = metadata || jsonb_build_object('ping_table', ping_table)
 where ping_table is not null
   and not (metadata ? 'ping_table');

alter table public.projects drop column if exists anon_key;
alter table public.projects drop column if exists ping_table;
alter table public.projects drop column if exists ref;
