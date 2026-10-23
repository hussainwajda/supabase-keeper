import "server-only";
import { headers } from "next/headers";
import { supabaseService } from "@/lib/supabase/service";
import { legacyClaimAllowed, legacyClaimEmail } from "@/lib/supabase/env";
import { usingNodeBackend } from "@/lib/backend/env";

export type OrphanCount = { accounts: number; projects: number; total: number };

/**
 * How many rows predate sign-in and have no owner.
 *
 * Counted with the service role because RLS deliberately hides unowned rows — that's the
 * whole reason the dashboard looks empty after migration 0003 and why this banner exists.
 */
export async function countOrphans(): Promise<OrphanCount> {
  const db = supabaseService();

  const [accounts, projects] = await Promise.all([
    db.from("accounts").select("id", { count: "exact", head: true }).is("user_id", null),
    db.from("projects").select("id", { count: "exact", head: true }).is("user_id", null),
  ]);

  // Pre-0003 the column doesn't exist yet; nothing to claim in that case.
  if (accounts.error?.code === "42703" || projects.error?.code === "42703") {
    return { accounts: 0, projects: 0, total: 0 };
  }
  if (accounts.error) throw accounts.error;
  if (projects.error) throw projects.error;

  const a = accounts.count ?? 0;
  const p = projects.count ?? 0;
  return { accounts: a, projects: p, total: a + p };
}

const NONE: OrphanCount = { accounts: 0, projects: 0, total: 0 };

/**
 * Is the claim banner allowed to appear for this user?
 *
 * `userEmail` is checked against `KEEPSTACK_LEGACY_CLAIM_EMAIL` when that is set, so the
 * banner only ever appears for the account that's meant to claim.
 */
export async function claimAvailable(
  userEmail?: string | null,
): Promise<{ allowed: boolean; orphans: OrphanCount }> {
  /*
   * Never offered on the Node backend. The claim exists because rows in the Postgres registry
   * predate authentication and have `user_id = null`; a MongoDB registry is either seeded by
   * the migration script — which carries ownership over from the source — or created by a
   * signed-in user, so an unowned document has no way to come into being.
   */
  if (usingNodeBackend()) return { allowed: false, orphans: NONE };

  if (!legacyClaimAllowed()) return { allowed: false, orphans: NONE };

  const pinned = legacyClaimEmail();
  if (pinned && userEmail?.trim().toLowerCase() !== pinned) {
    return { allowed: false, orphans: NONE };
  }

  const orphans = await countOrphans();
  return { allowed: orphans.total > 0, orphans };
}

/**
 * Assign every unowned row to `userId`.
 *
 * This is the only operation in Keepstack that can hand out ownership, which is why it is
 * gated four ways: the caller must be signed in, `KEEPSTACK_ALLOW_LEGACY_CLAIM` must be `true`
 * in the environment, the caller's email must match `KEEPSTACK_LEGACY_CLAIM_EMAIL` when that
 * is set, and there must actually be unowned rows. A public deployment never sets the flag,
 * so nobody can claim a stranger's registry.
 *
 * It is also idempotent: once nothing is unowned, a second call is a no-op.
 */
export async function claimLegacyRows(
  userId: string,
  userEmail?: string | null,
): Promise<OrphanCount> {
  if (!legacyClaimAllowed()) {
    throw new Error(
      "Claiming is disabled. Set KEEPSTACK_ALLOW_LEGACY_CLAIM=true in the environment to enable it once, then remove it.",
    );
  }

  // Re-checked here, not just in the UI: the banner being hidden is not a control.
  const pinned = legacyClaimEmail();
  if (pinned && userEmail?.trim().toLowerCase() !== pinned) {
    throw new Error(
      "This registry's unowned rows are reserved for a different account (KEEPSTACK_LEGACY_CLAIM_EMAIL).",
    );
  }

  const db = supabaseService();
  const before = await countOrphans();
  if (before.total === 0) return before;

  const { error: accountsError } = await db
    .from("accounts")
    .update({ user_id: userId })
    .is("user_id", null);
  if (accountsError) throw accountsError;

  const { error: projectsError } = await db
    .from("projects")
    .update({ user_id: userId })
    .is("user_id", null);
  if (projectsError) throw projectsError;

  const h = await headers();
  await db.from("audit_log").insert({
    user_id: userId,
    action: "registry.claim_legacy",
    method: "service_role",
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
    detail: { accounts: before.accounts, projects: before.projects, email: userEmail ?? null },
  });

  return before;
}
