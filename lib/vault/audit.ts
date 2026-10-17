import "server-only";
import { headers } from "next/headers";
import { supabaseService } from "@/lib/supabase/service";

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
  id: number;
  action: string;
  target_type: string | null;
  target_id: string | null;
  method: string | null;
  ip: string | null;
  user_agent: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};
