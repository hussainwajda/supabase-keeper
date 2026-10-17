import "server-only";
import { createHash, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import { aad, open, seal } from "./aead";
import { masterKey, pinPepper } from "./env";

/**
 * Per-user data encryption key (DEK) and the two ways it is wrapped.
 *
 * The DEK is 32 random bytes and is never stored unwrapped. Two wrapped copies live on the
 * user's profile row (see docs/SECURITY.md §2):
 *
 *   dek_pin — wrapped by scrypt(pin ‖ pepper, salt). The server cannot unwrap this alone.
 *   dek_srv — wrapped by KEEPSTACK_MASTER_KEY. This is the email-OTP recovery path, and the
 *             reason a holder of both the database and the environment can decrypt personal
 *             secrets. Users who don't want that can delete it ("no recovery").
 */

/**
 * scrypt cost. A PIN is low-entropy by nature (a 6-digit PIN is 10^6 possibilities), so the
 * KDF is the main thing standing between a leaked database and a brute-force — together with
 * the pepper, which lives only in the environment.
 *
 * N=2^17 costs 128 MB and ~170 ms on a dev laptop, so roughly half a second in a serverless
 * function. That is paid once per unlock, not per secret, so it is cheap where it matters and
 * expensive where an attacker would feel it. `maxmem` must be raised explicitly: Node's
 * default is 32 MB and would reject these parameters.
 */
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 288 << 20 } as const;

const PIN_SALT_BYTES = 16;
const DEK_BYTES = 32;

export function createDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

export function createPinSalt(): string {
  return randomBytes(PIN_SALT_BYTES).toString("base64");
}

function pinKey(pin: string, saltB64: string): Buffer {
  const salt = Buffer.from(saltB64, "base64");
  // The pepper is appended to the PIN rather than used as the salt, so the salt stays
  // per-user and the pepper stays global.
  const material = Buffer.concat([Buffer.from(pin.trim(), "utf8"), pinPepper()]);
  return scryptSync(material, salt, 32, SCRYPT);
}

const PIN_CONTEXT = (userId: string) => aad("keepstack/dek-pin/v1", userId);
const SRV_CONTEXT = (userId: string) => aad("keepstack/dek-srv/v1", userId);

export function wrapDekWithPin(dek: Buffer, pin: string, saltB64: string, userId: string): string {
  return seal(pinKey(pin, saltB64), dek, PIN_CONTEXT(userId));
}

/** Returns null when the PIN is wrong — the GCM tag is the check. */
export function unwrapDekWithPin(
  envelope: string,
  pin: string,
  saltB64: string,
  userId: string,
): Buffer | null {
  return open(pinKey(pin, saltB64), envelope, PIN_CONTEXT(userId));
}

export function wrapDekWithMaster(dek: Buffer, userId: string): string {
  return seal(masterKey(), dek, SRV_CONTEXT(userId));
}

export function unwrapDekWithMaster(envelope: string, userId: string): Buffer | null {
  return open(masterKey(), envelope, SRV_CONTEXT(userId));
}

/**
 * Session sealing.
 *
 * An unlock mints a random token. Its SHA-256 goes in the database to find the row; the raw
 * token only ever exists in the user's httpOnly cookie. The DEK is sealed under a key derived
 * from the raw token, so a stolen database snapshot does not yield the DEK — unsealing needs
 * a token the server never kept.
 */
export function sessionTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64");
}

function sessionKey(token: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(token, "utf8"), Buffer.alloc(0), "keepstack/vault-session/v1", 32),
  );
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sealDekForSession(dek: Buffer, token: string, userId: string): string {
  return seal(sessionKey(token), dek, aad("keepstack/vault-session/v1", userId));
}

export function openDekFromSession(envelope: string, token: string, userId: string): Buffer | null {
  return open(sessionKey(token), envelope, aad("keepstack/vault-session/v1", userId));
}
