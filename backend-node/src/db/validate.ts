import { PROVIDER_IDS, type Lifecycle, type ProviderId, type Strategy } from "../providers/types";
import { badRequest } from "../http/errors";

/**
 * The CHECK constraints, in code.
 *
 * Postgres enforced these: a `provider_id` enum, `lifecycle in (…)`, `strategy in (…)`,
 * `tier in ('server','personal')`, `interval_days between 1 and 60`. MongoDB will happily
 * store `lifecycle: "banana"`, so each one is re-expressed as a validator that runs before
 * the write.
 *
 * (MongoDB does offer `$jsonSchema` collection validators, which would put the rule back in
 * the database. They're not used here because the error they raise is a generic
 * `DocumentValidationFailure` with no indication of which field was wrong — fine as a
 * backstop, useless as the thing that produces a message for the user. These return the
 * field and the allowed values instead.)
 */

const LIFECYCLES: Lifecycle[] = ["active", "idle", "paused", "archived", "deleted", "unknown"];
const STRATEGIES: Strategy[] = ["ping", "watch", "alert_only"];
const TIERS = ["server", "personal"] as const;

export const MIN_INTERVAL_DAYS = 1;
/** 60, not 30: Atlas allows a 30-day idle window, so a 20-day interval is normal there. */
export const MAX_INTERVAL_DAYS = 60;

export function asProviderId(value: unknown): ProviderId {
  if (typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value)) {
    return value as ProviderId;
  }
  throw badRequest(`provider must be one of: ${PROVIDER_IDS.join(", ")}.`);
}

export function asLifecycle(value: unknown, fallback: Lifecycle = "unknown"): Lifecycle {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && (LIFECYCLES as string[]).includes(value)) {
    return value as Lifecycle;
  }
  throw badRequest(`lifecycle must be one of: ${LIFECYCLES.join(", ")}.`);
}

export function asStrategy(value: unknown, fallback: Strategy = "ping"): Strategy {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && (STRATEGIES as string[]).includes(value)) {
    return value as Strategy;
  }
  throw badRequest(`strategy must be one of: ${STRATEGIES.join(", ")}.`);
}

export function asTier(value: unknown, fallback: "server" | "personal" = "personal"): "server" | "personal" {
  if (value === undefined || value === null) return fallback;
  if (value === "server" || value === "personal") return value;
  throw badRequest(`tier must be one of: ${TIERS.join(", ")}.`);
}

/** Clamped rather than rejected, matching what `saveProject` already does in the Next.js app. */
export function asIntervalDays(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_INTERVAL_DAYS, Math.max(MIN_INTERVAL_DAYS, Math.round(parsed)));
}

/** `not null` on a text column, with a message naming the field. */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} is required.`);
  return value.trim();
}

export function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "on" || value === "1") return true;
  if (value === "false" || value === "off" || value === "0") return false;
  return fallback;
}

/** `metadata jsonb not null default '{}'` */
export function asMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
