import "server-only";
import { supabaseService } from "@/lib/supabase/service";
import {
  createDek,
  createPinSalt,
  unwrapDekWithMaster,
  unwrapDekWithPin,
  wrapDekWithMaster,
  wrapDekWithPin,
} from "@/lib/crypto/dek";
import { assertVaultEnv } from "@/lib/crypto/env";
import { audit } from "./audit";

/** 4-8 digits, matching what the UI accepts. */
export const PIN_PATTERN = /^\d{4,8}$/;

export const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_BASE_MINUTES = 15;

export type VaultProfile = {
  vault_initialized_at: string | null;
  pin_salt: string | null;
  dek_pin: string | null;
  dek_srv: string | null;
  pin_failed_attempts: number;
  pin_locked_until: string | null;
};

export async function getVaultProfile(userId: string): Promise<VaultProfile | null> {
  const { data, error } = await supabaseService()
    .from("profiles")
    .select(
      "vault_initialized_at, pin_salt, dek_pin, dek_srv, pin_failed_attempts, pin_locked_until",
    )
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as VaultProfile | null) ?? null;
}

export type VaultStatus = {
  initialized: boolean;
  /** False when the user has deleted the recovery copy of their DEK. */
  recoveryEnabled: boolean;
  lockedUntil: string | null;
  failedAttempts: number;
};

export async function vaultStatus(userId: string): Promise<VaultStatus> {
  const p = await getVaultProfile(userId);
  return {
    initialized: !!p?.vault_initialized_at && !!p.dek_pin,
    recoveryEnabled: !!p?.dek_srv,
    lockedUntil:
      p?.pin_locked_until && new Date(p.pin_locked_until) > new Date() ? p.pin_locked_until : null,
    failedAttempts: p?.pin_failed_attempts ?? 0,
  };
}

/**
 * First-time setup: mint a DEK and store both wrapped copies.
 *
 * Refuses if a vault already exists — changing a PIN must go through `changePin`, which
 * re-wraps the *existing* DEK. Minting a new one would orphan every secret already stored.
 */
export async function initializeVault(userId: string, pin: string): Promise<void> {
  assertVaultEnv();
  if (!PIN_PATTERN.test(pin)) throw new Error("Choose a PIN of 4 to 8 digits.");

  const existing = await getVaultProfile(userId);
  if (existing?.dek_pin) {
    throw new Error("This account already has a vault PIN. Change it instead of setting a new one.");
  }

  const dek = createDek();
  const salt = createPinSalt();

  const { error } = await supabaseService()
    .from("profiles")
    .update({
      pin_salt: salt,
      dek_pin: wrapDekWithPin(dek, pin, salt, userId),
      dek_srv: wrapDekWithMaster(dek, userId),
      vault_initialized_at: new Date().toISOString(),
      pin_failed_attempts: 0,
      pin_locked_until: null,
    })
    .eq("id", userId);
  if (error) throw error;

  await audit(userId, { action: "vault.pin_set", method: "pin" });
}

/** Lockout state, checked before any PIN is evaluated. */
export function lockoutRemainingMs(profile: VaultProfile | null): number {
  if (!profile?.pin_locked_until) return 0;
  return Math.max(0, new Date(profile.pin_locked_until).getTime() - Date.now());
}

async function recordFailure(userId: string, profile: VaultProfile): Promise<number> {
  const attempts = (profile.pin_failed_attempts ?? 0) + 1;
  const patch: Record<string, unknown> = { pin_failed_attempts: attempts };

  if (attempts >= MAX_PIN_ATTEMPTS) {
    // Escalating: 15 min, then 30, then 60… so repeated campaigns get progressively costlier.
    const rounds = Math.floor(attempts / MAX_PIN_ATTEMPTS);
    const minutes = LOCKOUT_BASE_MINUTES * 2 ** (rounds - 1);
    patch.pin_locked_until = new Date(Date.now() + minutes * 60_000).toISOString();
    await audit(userId, {
      action: "vault.locked_out",
      method: "pin",
      detail: { attempts, minutes },
    });
  }

  await supabaseService().from("profiles").update(patch).eq("id", userId);
  return attempts;
}

async function clearFailures(userId: string): Promise<void> {
  await supabaseService()
    .from("profiles")
    .update({ pin_failed_attempts: 0, pin_locked_until: null })
    .eq("id", userId);
}

export type UnwrapResult =
  | { ok: true; dek: Buffer }
  | { ok: false; reason: "no_vault" | "wrong_pin" | "locked"; retriesLeft?: number; lockedMs?: number };

/** Unwrap the DEK with a PIN, applying rate limiting. Used by the unlock flow only. */
export async function unwrapWithPin(userId: string, pin: string): Promise<UnwrapResult> {
  assertVaultEnv();
  const profile = await getVaultProfile(userId);
  if (!profile?.dek_pin || !profile.pin_salt) return { ok: false, reason: "no_vault" };

  const lockedMs = lockoutRemainingMs(profile);
  if (lockedMs > 0) return { ok: false, reason: "locked", lockedMs };

  const dek = unwrapDekWithPin(profile.dek_pin, pin, profile.pin_salt, userId);
  if (!dek) {
    const attempts = await recordFailure(userId, profile);
    await audit(userId, { action: "vault.unlock_failed", method: "pin", detail: { attempts } });
    return {
      ok: false,
      reason: "wrong_pin",
      retriesLeft: Math.max(0, MAX_PIN_ATTEMPTS - (attempts % MAX_PIN_ATTEMPTS || MAX_PIN_ATTEMPTS)),
    };
  }

  if (profile.pin_failed_attempts > 0) await clearFailures(userId);
  return { ok: true, dek };
}

/** Unwrap via the recovery copy. Only reachable after an email OTP has been verified. */
export async function unwrapWithMaster(userId: string): Promise<Buffer | null> {
  assertVaultEnv();
  const profile = await getVaultProfile(userId);
  if (!profile?.dek_srv) return null;
  return unwrapDekWithMaster(profile.dek_srv, userId);
}

/** Change the PIN, keeping the same DEK so stored secrets stay readable. */
export async function changePin(userId: string, dek: Buffer, newPin: string): Promise<void> {
  assertVaultEnv();
  if (!PIN_PATTERN.test(newPin)) throw new Error("Choose a PIN of 4 to 8 digits.");

  const salt = createPinSalt();
  const { error } = await supabaseService()
    .from("profiles")
    .update({
      pin_salt: salt,
      dek_pin: wrapDekWithPin(dek, newPin, salt, userId),
      pin_failed_attempts: 0,
      pin_locked_until: null,
      vault_initialized_at: new Date().toISOString(),
    })
    .eq("id", userId);
  if (error) throw error;

  await audit(userId, { action: "vault.pin_changed", method: "pin" });
}

/**
 * Delete the recovery copy of the DEK, making the deployment genuinely zero-knowledge for
 * this user's personal secrets.
 *
 * After this, forgetting the PIN means those secrets are unrecoverable by anyone, including
 * the server operator. That is the point, and it is why the UI makes the user type a
 * confirmation phrase.
 */
export async function disableRecovery(userId: string): Promise<void> {
  const { error } = await supabaseService()
    .from("profiles")
    .update({ dek_srv: null })
    .eq("id", userId);
  if (error) throw error;
  await audit(userId, { action: "vault.recovery_disabled" });
}
