import "server-only";
import { cookies, headers } from "next/headers";
import { supabaseService } from "@/lib/supabase/service";
import {
  createSessionToken,
  openDekFromSession,
  sealDekForSession,
  sessionTokenHash,
} from "@/lib/crypto/dek";
import { audit } from "./audit";
import { usingNodeBackend } from "@/lib/backend/env";
import * as api from "@/lib/backend/api";


export const VAULT_COOKIE = "ks_vault";
/** Sudo mode lasts 10 minutes, like GitHub's. Long enough to do a task, short enough to matter. */
export const VAULT_SESSION_MINUTES = 10;

/**
 * Open a vault session.
 *
 * The raw token goes to the browser in an httpOnly cookie and is never stored. Its SHA-256
 * locates the row, and the DEK is sealed under a key derived from the raw token — so the
 * database on its own cannot yield the DEK.
 */
export async function openVaultSession(
  userId: string,
  dek: Buffer,
  method: "pin" | "otp",
): Promise<void> {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + VAULT_SESSION_MINUTES * 60_000);
  const h = await headers();

  const { error } = await supabaseService().from("vault_sessions").insert({
    user_id: userId,
    token_hash: sessionTokenHash(token),
    dek_sealed: sealDekForSession(dek, token, userId),
    method,
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
    expires_at: expiresAt.toISOString(),
  });
  if (error) throw error;

  (await cookies()).set(VAULT_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });

  await audit(userId, { action: "vault.unlock", method });
}

/**
 * The unwrapped DEK for the current request, or null when the vault is locked.
 *
 * Expired rows are deleted on sight rather than merely ignored, so a stale sealed DEK doesn't
 * sit in the database waiting to be useful to someone.
 */
export async function currentDek(userId: string): Promise<Buffer | null> {
  const token = (await cookies()).get(VAULT_COOKIE)?.value;
  if (!token) return null;

  const db = supabaseService();
  const { data, error } = await db
    .from("vault_sessions")
    .select("id, user_id, dek_sealed, expires_at")
    .eq("token_hash", sessionTokenHash(token))
    .maybeSingle();
  if (error || !data) return null;

  // Belt and braces: the token already identifies the row, but a session must never be
  // usable by a different signed-in account.
  if (data.user_id !== userId) return null;

  if (new Date(data.expires_at) <= new Date()) {
    await db.from("vault_sessions").delete().eq("id", data.id);
    return null;
  }

  return openDekFromSession(data.dek_sealed as string, token, userId);
}

export async function vaultUnlocked(userId: string): Promise<boolean> {
  // On the Node backend the DEK never enters this process — it is sealed in the API's own
  // session store and unsealed there. So "is the vault open" becomes a question we ask rather
  // than one we answer locally, which is why `currentDek` has no node branch.
  if (usingNodeBackend()) return (await api.vaultStatus()).unlocked;

  return (await currentDek(userId)) !== null;
}

/** Remaining sudo time in seconds, for the countdown in the UI. */
export async function vaultSessionRemaining(userId: string): Promise<number> {
  if (usingNodeBackend()) return (await api.vaultStatus()).remaining_seconds;

  const token = (await cookies()).get(VAULT_COOKIE)?.value;
  if (!token) return 0;

  const { data } = await supabaseService()
    .from("vault_sessions")
    .select("expires_at, user_id")
    .eq("token_hash", sessionTokenHash(token))
    .maybeSingle();
  if (!data || data.user_id !== userId) return 0;

  return Math.max(0, Math.floor((new Date(data.expires_at).getTime() - Date.now()) / 1000));
}

/** Lock now: delete this session row and drop the cookie. */
export async function lockVault(userId: string): Promise<void> {
  const jar = await cookies();
  const token = jar.get(VAULT_COOKIE)?.value;
  if (token) {
    await supabaseService()
      .from("vault_sessions")
      .delete()
      .eq("token_hash", sessionTokenHash(token));
  }
  jar.delete(VAULT_COOKIE);
  await audit(userId, { action: "vault.lock" });
}

/** Revoke every session for this user, including those in other browsers. */
export async function lockAllSessions(userId: string): Promise<void> {
  await supabaseService().from("vault_sessions").delete().eq("user_id", userId);
  (await cookies()).delete(VAULT_COOKIE);
  await audit(userId, { action: "vault.lock", detail: { scope: "all" } });
}

export type VaultSessionRow = {
  id: string;
  method: string;
  ip: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
};

export async function listVaultSessions(userId: string): Promise<VaultSessionRow[]> {
  if (usingNodeBackend()) return (await api.listVaultSessions()).sessions;

  const { data, error } = await supabaseService()
    .from("vault_sessions")
    .select("id, method, ip, user_agent, expires_at, created_at")
    .eq("user_id", userId)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as VaultSessionRow[];
}

/** Housekeeping, called from the nightly sweep. */
export async function pruneExpiredSessions(): Promise<void> {
  const now = new Date().toISOString();
  await supabaseService().from("vault_sessions").delete().lt("expires_at", now);
  await supabaseService().from("otp_challenges").delete().lt("expires_at", now);
}
