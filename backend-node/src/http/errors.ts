import type { NextFunction, Request, Response } from "express";

/**
 * A failure with an HTTP status attached.
 *
 * Everything thrown deliberately is an `ApiError`; anything else is a bug and becomes a 500
 * with its detail kept out of the response. That split is what stops a driver error — which
 * can echo the write payload, and therefore a ciphertext or a credential — from reaching the
 * client. `lib/vault/migrate-keys.ts` makes the same point about logging message-only.
 */
export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable, so a client can branch without matching on prose. */
  readonly code: string;
  readonly detail: Record<string, unknown> | undefined;

  constructor(status: number, message: string, code: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (message: string, detail?: Record<string, unknown>) =>
  new ApiError(400, message, "bad_request", detail);

export const unauthorized = (message = "Sign in first.") =>
  new ApiError(401, message, "unauthorized");

/** Used for "the vault is locked", which is a distinct state from "not signed in". */
export const vaultLocked = (message = "Your vault is locked. Unlock it first.") =>
  new ApiError(403, message, "vault_locked");

export const forbidden = (message: string) => new ApiError(403, message, "forbidden");

/**
 * The one message this backend is careful about.
 *
 * "That project doesn't exist, or isn't yours" — never "that isn't yours", which would
 * confirm the id belongs to somebody. The Supabase version got this property for free,
 * because RLS made someone else's row genuinely indistinguishable from a missing one.
 */
export const notFound = (what = "That record doesn't exist, or isn't yours.") =>
  new ApiError(404, what, "not_found");

export const conflict = (message: string) => new ApiError(409, message, "conflict");

export const tooManyRequests = (message: string, detail?: Record<string, unknown>) =>
  new ApiError(429, message, "rate_limited", detail);

export const notImplemented = (message: string) =>
  new ApiError(501, message, "not_implemented");

/** Express's terminal error handler. Must keep all four parameters to be recognised as one. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.detail ? { detail: err.detail } : {}),
    });
    return;
  }

  // A duplicate key is a constraint doing its job, so translate it rather than 500-ing.
  // Which constraint it was comes from the index name, set in src/db/indexes.ts.
  const mongoError = err as { code?: number; message?: string };
  if (mongoError?.code === 11000) {
    res.status(409).json({
      error: duplicateKeyMessage(mongoError.message ?? ""),
      code: "conflict",
    });
    return;
  }

  console.error("[keepstack:backend] unhandled error", err);
  res.status(500).json({ error: "Something went wrong.", code: "internal_error" });
}

function duplicateKeyMessage(raw: string): string {
  if (raw.includes("projects_user_provider_external_unique")) {
    return "You already have a project registered with that identifier for this provider.";
  }
  if (raw.includes("accounts_user_provider_email_unique")) {
    return "You already have an account with that email for this provider.";
  }
  if (raw.includes("secrets_account_kind_unique") || raw.includes("secrets_project_kind_unique")) {
    return "A credential of that kind is already stored here. Saving again replaces it.";
  }
  if (raw.includes("users_email_unique")) return "An account with that email already exists.";
  if (raw.includes("usage_daily_unique")) {
    return "That metric already has a reading for today.";
  }
  return "That value is already taken.";
}
