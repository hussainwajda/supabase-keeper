import { auditLog } from "../db/collections";
import { newId } from "../db/ids";
import { owned, type Scope } from "../db/scope";
import { toAuditRow } from "../http/serialize";

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

/** Who the request came from. Passed in rather than read from a global — see below. */
export type RequestOrigin = { ip: string | null; userAgent: string | null };

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
 * Records *that* a secret was touched — never its value. `detail` carries things like the
 * secret's kind and label and is reviewed as carefully as any other log sink.
 *
 * One structural change from the Next.js version: the IP and user agent arrive as an argument
 * instead of being read from `headers()`. Next's async-context globals meant every caller got
 * them for free; here the same convenience would be a trap, because the two most important
 * callers have no request at all — the nightly sweep and the migration script. An implicit
 * read would have thrown there, or worse, quietly attributed one user's sweep action to
 * whichever request happened to be in flight.
 *
 * Audit failures never block the action they describe, but they are logged loudly — a silent
 * audit gap is the one thing worse than a noisy one.
 */
export async function audit(
  userId: string,
  entry: AuditEntry,
  origin?: RequestOrigin | null,
): Promise<void> {
  try {
    await auditLog().insertOne({
      _id: newId(),
      user_id: userId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      method: entry.method ?? null,
      ip: origin?.ip ?? null,
      user_agent: origin?.userAgent ?? null,
      detail: entry.detail ?? {},
      created_at: new Date(),
    });
  } catch (e) {
    console.error("[keepstack:backend] failed to write audit entry", entry.action, e);
  }
}

/**
 * The user's own audit trail.
 *
 * Read-only by design. In Postgres this was enforced by giving `audit_log` a SELECT policy
 * and no INSERT policy — "append-only from the user's side: readable, never editable". There
 * is no policy engine here, so the guarantee is structural instead: this module exports a
 * reader and `audit()`, and no route is wired to anything that updates or deletes a row.
 */
export async function listAudit(scope: Scope, limit = 100) {
  const docs = await auditLog()
    .find(owned(scope))
    .sort({ created_at: -1 })
    .limit(Math.min(500, Math.max(1, limit)))
    .toArray();
  return docs.map(toAuditRow);
}
