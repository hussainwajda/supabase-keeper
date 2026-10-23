import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { authSessions } from "../db/collections";
import { newId } from "../db/ids";
import type { UserDoc } from "../db/documents";
import { sessionTtlDays } from "../config/env";
import { clearCookie, readCookie, setCookie } from "../http/cookies";
import { requestOrigin } from "../http/handler";
import { findUserById } from "./users";

/**
 * Dashboard login sessions — the job Supabase Auth was doing.
 *
 * Opaque random tokens in an httpOnly cookie, not JWTs. A JWT would avoid a database read per
 * request, and that is the only thing it would buy: it cannot be revoked before it expires,
 * which for a tool that holds provider credentials and a vault is the wrong trade. "Sign out
 * everywhere" has to actually mean it. The read is a single indexed lookup on a collection
 * this process is already connected to.
 *
 * Only the SHA-256 of the token is stored, the same pattern as the vault's sessions: a
 * database snapshot yields hashes, and a hash is not a usable credential.
 */
export const SESSION_COOKIE = "ks_session";

const tokenHash = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("base64");

export async function startSession(req: Request, res: Response, userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionTtlDays() * 24 * 60 * 60 * 1000);
  const { ip, userAgent } = requestOrigin(req);

  await authSessions().insertOne({
    _id: newId(),
    user_id: userId,
    token_hash: tokenHash(token),
    ip,
    user_agent: userAgent,
    expires_at: expiresAt,
    created_at: new Date(),
  });

  setCookie(res, SESSION_COOKIE, token, expiresAt);
}

/**
 * The signed-in user for this request, or null.
 *
 * Expiry is checked here and not left to the TTL index. MongoDB's TTL monitor runs about once
 * a minute, so a document can outlive its `expires_at` by up to that long — fine as
 * housekeeping, not something to authenticate against. The index keeps the collection tidy;
 * this comparison is what actually ends the session.
 */
export async function currentUser(req: Request): Promise<UserDoc | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const session = await authSessions().findOne({ token_hash: tokenHash(token) });
  if (!session) return null;

  if (session.expires_at <= new Date()) {
    await authSessions().deleteOne({ _id: session._id });
    return null;
  }

  return findUserById(session.user_id);
}

export async function endSession(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await authSessions().deleteOne({ token_hash: tokenHash(token) });
  clearCookie(res, SESSION_COOKIE);
}

/** Revoke every session for a user — password change, or "sign out everywhere". */
export async function endAllSessions(userId: string): Promise<number> {
  const { deletedCount } = await authSessions().deleteMany({ user_id: userId });
  return deletedCount ?? 0;
}
