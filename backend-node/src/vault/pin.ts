import { users } from "../db/collections";
import {
  createDek,
  createPinSalt,
  unwrapDekWithMaster,
  unwrapDekWithPin,
  wrapDekWithMaster,
  wrapDekWithPin,
} from "../crypto/dek";
import { assertVaultEnv } from "../crypto/env";
import { badRequest } from "../http/errors";
import { audit, type RequestOrigin } from "./audit";

/** 4-8 digits, matching what the UI accepts. */
export const PIN_PATTERN = /^\d{4,8}$/;

export const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_BASE_MINUTES = 15;

/**
 * The vault half of a user document — what used to be six columns on `profiles`.
 *
 * The crypto is untouched by the port. `dek_pin` is the DEK wrapped by
 * scrypt(pin ‖ pepper, salt); `dek_srv` is the same DEK wrapped by KEEPSTACK_MASTER_KEY for
 * the email-recovery path. Both envelopes are bound by AAD to the user's id, which is exactly
 * why the migration preserves ids rather than minting new ones — see `src/db/ids.ts`.
 */
export type VaultProfile = {
  vault_initialized_at: Date | null;
  pin_salt: string | null;
  dek_pin: string | null;
  dek_srv: string | null;
  pin_failed_attempts: number;
  pin_locked_until: Date | null;
};

export async function getVaultProfile(userId: string): Promise<VaultProfile | null> {
  const doc = await users().findOne(
    { _id: userId },
    {
      projection: {
        vault_initialized_at: 1,
        pin_salt: 1,
        dek_pin: 1,
        dek_srv: 1,
        pin_failed_attempts: 1,
        pin_locked_until: 1,
      },
    },
  );
  if (!doc) return null;

  return {
    vault_initialized_at: doc.vault_initialized_at ?? null,
    pin_salt: doc.pin_salt ?? null,
    dek_pin: doc.dek_pin ?? null,
    dek_srv: doc.dek_srv ?? null,
    pin_failed_attempts: doc.pin_failed_attempts ?? 0,
    pin_locked_until: doc.pin_locked_until ?? null,
  };
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
  const locked = p?.pin_locked_until && p.pin_locked_until > new Date() ? p.pin_locked_until : null;
  return {
    initialized: !!p?.vault_initialized_at && !!p.dek_pin,
    recoveryEnabled: !!p?.dek_srv,
    lockedUntil: locked ? locked.toISOString() : null,
    failedAttempts: p?.pin_failed_attempts ?? 0,
  };
}

/**
 * First-time setup: mint a DEK and store both wrapped copies.
 *
 * Refuses if a vault already exists — changing a PIN must go through `changePin`, which
 * re-wraps the *existing* DEK. Minting a new one would orphan every secret already stored.
 */
export async function initializeVault(
  userId: string,
  pin: string,
  origin?: RequestOrigin,
): Promise<void> {
  assertVaultEnv();
  if (!PIN_PATTERN.test(pin)) throw badRequest("Choose a PIN of 4 to 8 digits.");

  const existing = await getVaultProfile(userId);
  if (existing?.dek_pin) {
    throw badRequest("This account already has a vault PIN. Change it instead of setting a new one.");
  }

  const dek = createDek();
  const salt = createPinSalt();

  await users().updateOne(
    { _id: userId },
    {
      $set: {
        pin_salt: salt,
        dek_pin: wrapDekWithPin(dek, pin, salt, userId),
        dek_srv: wrapDekWithMaster(dek, userId),
        vault_initialized_at: new Date(),
        pin_failed_attempts: 0,
        pin_locked_until: null,
        updated_at: new Date(),
      },
    },
  );

  await audit(userId, { action: "vault.pin_set", method: "pin" }, origin);
}

/** Lockout state, checked before any PIN is evaluated. */
export function lockoutRemainingMs(profile: VaultProfile | null): number {
  if (!profile?.pin_locked_until) return 0;
  return Math.max(0, profile.pin_locked_until.getTime() - Date.now());
}

/**
 * Count a wrong PIN and lock the vault once there have been too many.
 *
 * `$inc` rather than read-then-write, which is a genuine improvement over the Supabase
 * version rather than just a different spelling. There, the new count was computed in
 * application code from a value read a moment earlier, so five wrong PINs submitted at once
 * could each read `0` and each write `1` — and the lockout would never trigger. A single
 * `findOneAndUpdate` with `$inc` is atomic in the server, so every attempt is counted even
 * when they arrive together.
 */
async function recordFailure(userId: string, origin?: RequestOrigin): Promise<number> {
  const updated = await users().findOneAndUpdate(
    { _id: userId },
    { $inc: { pin_failed_attempts: 1 }, $set: { updated_at: new Date() } },
    { returnDocument: "after", projection: { pin_failed_attempts: 1 } },
  );

  const attempts = updated?.pin_failed_attempts ?? 1;

  if (attempts >= MAX_PIN_ATTEMPTS && attempts % MAX_PIN_ATTEMPTS === 0) {
    // Escalating: 15 min, then 30, then 60… so repeated campaigns get progressively costlier.
    const rounds = Math.floor(attempts / MAX_PIN_ATTEMPTS);
    const minutes = LOCKOUT_BASE_MINUTES * 2 ** (rounds - 1);
    await users().updateOne(
      { _id: userId },
      { $set: { pin_locked_until: new Date(Date.now() + minutes * 60_000) } },
    );
    await audit(
      userId,
      { action: "vault.locked_out", method: "pin", detail: { attempts, minutes } },
      origin,
    );
  }

  return attempts;
}

async function clearFailures(userId: string): Promise<void> {
  await users().updateOne(
    { _id: userId },
    { $set: { pin_failed_attempts: 0, pin_locked_until: null } },
  );
}

export type UnwrapResult =
  | { ok: true; dek: Buffer }
  | {
      ok: false;
      reason: "no_vault" | "wrong_pin" | "locked";
      retriesLeft?: number;
      lockedMs?: number;
    };

/** Unwrap the DEK with a PIN, applying rate limiting. Used by the unlock flow only. */
export async function unwrapWithPin(
  userId: string,
  pin: string,
  origin?: RequestOrigin,
): Promise<UnwrapResult> {
  assertVaultEnv();
  const profile = await getVaultProfile(userId);
  if (!profile?.dek_pin || !profile.pin_salt) return { ok: false, reason: "no_vault" };

  const lockedMs = lockoutRemainingMs(profile);
  if (lockedMs > 0) return { ok: false, reason: "locked", lockedMs };

  // The GCM tag is the only verifier — there is no separate PIN hash for an attacker to work
  // on, which is the point of wrapping rather than hashing.
  const dek = unwrapDekWithPin(profile.dek_pin, pin, profile.pin_salt, userId);
  if (!dek) {
    const attempts = await recordFailure(userId, origin);
    await audit(userId, { action: "vault.unlock_failed", method: "pin", detail: { attempts } }, origin);
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
export async function changePin(
  userId: string,
  dek: Buffer,
  newPin: string,
  origin?: RequestOrigin,
): Promise<void> {
  assertVaultEnv();
  if (!PIN_PATTERN.test(newPin)) throw badRequest("Choose a PIN of 4 to 8 digits.");

  const salt = createPinSalt();
  await users().updateOne(
    { _id: userId },
    {
      $set: {
        pin_salt: salt,
        dek_pin: wrapDekWithPin(dek, newPin, salt, userId),
        pin_failed_attempts: 0,
        pin_locked_until: null,
        vault_initialized_at: new Date(),
        updated_at: new Date(),
      },
    },
  );

  await audit(userId, { action: "vault.pin_changed", method: "pin" }, origin);
}

/**
 * Delete the recovery copy of the DEK, making the deployment genuinely zero-knowledge for
 * this user's personal secrets.
 *
 * After this, forgetting the PIN means those secrets are unrecoverable by anyone, including
 * whoever runs the server. That is the point, and it is why the caller makes the user type a
 * confirmation phrase.
 */
export async function disableRecovery(userId: string, origin?: RequestOrigin): Promise<void> {
  await users().updateOne({ _id: userId }, { $set: { dek_srv: null, updated_at: new Date() } });
  await audit(userId, { action: "vault.recovery_disabled" }, origin);
}
