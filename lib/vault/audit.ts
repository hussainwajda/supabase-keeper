import "server-only";
import { headers } from "next/headers";
import { supabaseService } from "@/lib/supabase/service";
import { supabaseServer } from "@/lib/supabase/server";
import { usingNodeBackend } from "@/lib/backend/env";
import * as api from "@/lib/backend/api";

export type AuditAction =
  | "vault.pin_set"
  | "vault.pin_changed"
  | "vault.pin_reset"
  | "vault.unlock"
  | "vault.unlock_failed"
  | "vault.locked_out"
  | "vault.otp_sent"
  | "vault.recovery_disabled"
  | "vault.lock"
  | "secret.create"
  | "secret.update"
  | "secret.delete"
  | "secret.reveal"
  | "secret.migrated"
  | "registry.claim_legacy";

export type AuditEntry = {
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  method?: "pin" | "otp" | "service_role" | null;
  detail?: Record<string, unknown>;
};

/**
 * Append to the audit log.
 *
 * Records *that* a secret was touched — never its value. `detail` is for things like the
 * secret's kind and label, and is reviewed as carefully as any other log sink.
 *
 * Written with the service role because `audit_log` has no user-facing INSERT policy: the
 * log would be worthless if the user could write or edit their own entries.
 *
 * Audit failures never block the action they describe, but they are logged loudly — a silent
 * audit gap is the one thing worse than a noisy one.
 */
export async function audit(userId: string, entry: AuditEntry): Promise<void> {
  try {
    const h = await headers();
    await supabaseService()
      .from("audit_log")
      .insert({
        user_id: userId,
        action: entry.action,
        target_type: entry.targetType ?? null,
        target_id: entry.targetId ?? null,
        method: entry.method ?? null,
        ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        user_agent: h.get("user-agent"),
        detail: entry.detail ?? {},
      });
  } catch (e) {
    console.error("[keepstack] failed to write audit entry", entry.action, e);
  }
}

export type AuditRow = {
  /**
   * `number` under Supabase (a Postgres `bigint`), `string` under the Node backend (a UUID —
   * see backend-node/src/db/ids.ts). Widened rather than cast at the boundary because it is
   * only ever a React key; nothing does arithmetic on it.
   */
  id: number | string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  method: string | null;
  ip: string | null;
  user_agent: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};

/**
 * The user's own audit trail.
 *
 * Read through the *user* client on the Supabase side, so the `audit_log: read own` policy is
 * what enforces the scope rather than the `.eq("user_id", …)` below being the only thing
 * standing between users. The Node backend scopes it server-side for the same reason — see
 * `backend-node/src/vault/audit.ts`.
 */
export async function listAuditEntries(userId: string, limit = 40): Promise<AuditRow[]> {
  if (usingNodeBackend()) return (await api.listAudit(limit)).entries;

  const { data } = await (await supabaseServer())
    .from("audit_log")
    .select("id, action, target_type, target_id, method, ip, user_agent, detail, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []) as AuditRow[];
}
