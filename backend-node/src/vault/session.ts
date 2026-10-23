import type { Request, Response } from "express";
import { vaultSessions, otpChallenges } from "../db/collections";
import { newId } from "../db/ids";
import {
  createSessionToken,
  openDekFromSession,
  sealDekForSession,
  sessionTokenHash,
} from "../crypto/dek";
import { clearCookie, readCookie, setCookie } from "../http/cookies";
import { requestOrigin } from "../http/handler";
import { audit } from "./audit";

export const VAULT_COOKIE = "ks_vault";
/** Sudo mode lasts 10 minutes, like GitHub's. Long enough to do a task, short enough to matter. */
export const VAULT_SESSION_MINUTES = 10;

/**
 * Open a vault session.
 *
 * The raw token goes to the browser in an httpOnly cookie and is never stored. Its SHA-256
 * locates the document, and the DEK is sealed under a key derived from the raw token — so the
 * database on its own cannot yield the DEK. That property is the reason this survives the
 * move to MongoDB unchanged: it never depended on anything Postgres was doing.
 */
export async function openVaultSession(
  userId: string,
  dek: Buffer,
  method: "pin" | "otp",
  req: Request,
  res: Response,
): Promise<void> {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + VAULT_SESSION_MINUTES * 60_000);
  const { ip, userAgent } = requestOrigin(req);

  await vaultSessions().insertOne({
    _id: newId(),
    user_id: userId,
    token_hash: sessionTokenHash(token),
    dek_sealed: sealDekForSession(dek, token, userId),
    method,
    ip,
    user_agent: userAgent,
    expires_at: expiresAt,
    created_at: new Date(),
  });

  setCookie(res, VAULT_COOKIE, token, expiresAt);
  await audit(userId, { action: "vault.unlock", method }, { ip, userAgent });
}

/**
 * The unwrapped DEK for the current request, or null when the vault is locked.
 *
 * Expired documents are deleted on sight rather than merely ignored, so a stale sealed DEK
 * doesn't sit in the database waiting to be useful to someone. The TTL index on `expires_at`
 * does the same job as housekeeping, but its monitor runs about once a minute — too loose to
 * be the thing that ends a sudo window, and that comparison below is what actually does.
 */
export async function currentDek(userId: string, req: Request): Promise<Buffer | null> {
  const token = readCookie(req, VAULT_COOKIE);
  if (!token) return null;

  const session = await vaultSessions().findOne({ token_hash: sessionTokenHash(token) });
  if (!session) return null;

  // Belt and braces: the token already identifies the document, but a session must never be
  // usable by a different signed-in account.
  if (session.user_id !== userId) return null;

  if (session.expires_at <= new Date()) {
    await vaultSessions().deleteOne({ _id: session._id });
    return null;
  }

  return openDekFromSession(session.dek_sealed, token, userId);
}

export async function vaultUnlocked(userId: string, req: Request): Promise<boolean> {
  return (await currentDek(userId, req)) !== null;
}

/** Remaining sudo time in seconds, for the countdown in the UI. */
export async function vaultSessionRemaining(userId: string, req: Request): Promise<number> {
  const token = readCookie(req, VAULT_COOKIE);
  if (!token) return 0;

  const session = await vaultSessions().findOne({ token_hash: sessionTokenHash(token) });
  if (!session || session.user_id !== userId) return 0;

  return Math.max(0, Math.floor((session.expires_at.getTime() - Date.now()) / 1000));
}

/** Lock now: delete this session document and drop the cookie. */
export async function lockVault(userId: string, req: Request, res: Response): Promise<void> {
  const token = readCookie(req, VAULT_COOKIE);
  if (token) await vaultSessions().deleteOne({ token_hash: sessionTokenHash(token) });
  clearCookie(res, VAULT_COOKIE);
  await audit(userId, { action: "vault.lock" }, requestOrigin(req));
}

/** Revoke every vault session for this user, including those in other browsers. */
export async function lockAllSessions(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  await vaultSessions().deleteMany({ user_id: userId });
  clearCookie(res, VAULT_COOKIE);
  await audit(userId, { action: "vault.lock", detail: { scope: "all" } }, requestOrigin(req));
}

export type VaultSessionSummary = {
  id: string;
  method: string;
  ip: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
};

export async function listVaultSessions(userId: string): Promise<VaultSessionSummary[]> {
  const docs = await vaultSessions()
    .find({ user_id: userId, expires_at: { $gt: new Date() } })
    .sort({ created_at: -1 })
    .toArray();

  // `dek_sealed` and `token_hash` are named out of the result rather than deleted from it:
  // a sealed DEK has no business in an HTTP response, even an authenticated one.
  return docs.map((s) => ({
    id: s._id,
    method: s.method,
    ip: s.ip,
    user_agent: s.user_agent,
    expires_at: s.expires_at.toISOString(),
    created_at: s.created_at.toISOString(),
  }));
}

/**
 * Housekeeping.
 *
 * Mostly redundant now: both collections carry a TTL index on `expires_at`
 * (`src/db/indexes.ts`), so MongoDB expires these without being asked — which is why the
 * sweep no longer has to spend part of its budget on deletes the way the Postgres version
 * did. Kept because the TTL monitor is best-effort and about a minute late, and because a
 * deployment that lost its indexes should still be able to clean up.
 */
export async function pruneExpiredSessions(): Promise<{ sessions: number; challenges: number }> {
  const now = new Date();
  const sessions = await vaultSessions().deleteMany({ expires_at: { $lt: now } });
  const challenges = await otpChallenges().deleteMany({ expires_at: { $lt: now } });
  return { sessions: sessions.deletedCount ?? 0, challenges: challenges.deletedCount ?? 0 };
}
