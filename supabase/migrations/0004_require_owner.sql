-- Keepstack 0004 — make ownership mandatory (Phase 1, run LAST)
--
-- Run this only after you have signed in and used the dashboard's "Claim these rows" banner.
-- It refuses to run while any unowned row remains, so it is safe to try early.
--
-- Afterwards, remove KEEPSTACK_ALLOW_LEGACY_CLAIM from your environment: the claim path is
-- service-role and is the one thing in Keepstack that can assign ownership, so it should not
-- stay reachable.

do $$
declare
  orphan_accounts int;
  orphan_projects int;
begin
  select count(*) into orphan_accounts from public.accounts where user_id is null;
  select count(*) into orphan_projects from public.projects where user_id is null;

  if orphan_accounts > 0 or orphan_projects > 0 then
    raise exception
      'Still unclaimed: % account(s) and % project(s) have no owner.'
      '  This migration runs AFTER app-side steps: (1) set NEXT_PUBLIC_SUPABASE_ANON_KEY,'
      '  (2) sign in, (3) press "Claim these rows" on the dashboard. Then re-run this.'
      '  Nothing is broken in the meantime — unowned rows are simply hidden by RLS.',
      orphan_accounts, orphan_projects;
  end if;
end $$;

alter table public.accounts alter column user_id set not null;
alter table public.projects alter column user_id set not null;
