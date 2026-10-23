import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing.
 *
 * Supabase Auth did this, so there was no equivalent file in the Next.js app — which makes it
 * the one piece of security-relevant code here that isn't a port of something already
 * reviewed. Worth stating the choices rather than leaving them implicit.
 *
 * **scrypt, from `node:crypto`.** Argon2id would be the fashionable answer and is a fine one,
 * but it means a native module in a service whose entire job is holding other people's
 * credentials, and scrypt (RFC 7914) is memory-hard, in the standard library, and already the
 * KDF this codebase uses for the vault PIN (`src/crypto/dek.ts`). One KDF, no new
 * dependency, no build step that can fail on a different architecture.
 *
 * **N = 2^16 (64 MB), r = 8, p = 1.** Lower than the PIN's 2^17, deliberately. A PIN has
 * ~20 bits of entropy and the KDF is the only thing standing between a leaked database and a
 * complete break, so it is tuned as high as a serverless function can bear. A password is
 * longer and the cost is paid on every login, where ~100 ms is the budget before sign-in
 * feels broken. `maxmem` has to be raised explicitly: Node's default is 32 MB and would
 * reject these parameters outright.
 *
 * **Self-describing hashes.** The encoded string carries its own parameters, so raising the
 * cost later doesn't invalidate existing hashes — old ones keep verifying under the
 * parameters they were made with, and `needsRehash` says which ones to upgrade on next login.
 */
const N = 1 << 16;
const R = 8;
const P = 1;
const MAXMEM = 144 << 20;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

export const MIN_PASSWORD_LENGTH = 8;

/** `scrypt$N$r$p$salt$hash`, both parts base64. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password.normalize("NFKC"), salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAXMEM });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

/**
 * Verify a password against an encoded hash.
 *
 * Returns false for a malformed hash rather than throwing, so a corrupted row is a failed
 * login and not a 500 that tells an attacker they found something interesting.
 */
export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters from a tampered row: scrypt with a huge N is a denial of service
  // against our own CPU, performed on request.
  if (n > 1 << 20 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password.normalize("NFKC"), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    });
  } catch {
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when a stored hash was made with weaker parameters than the current ones. */
export function needsRehash(encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) < N || Number(parts[2]) < R;
}

/**
 * Minimum policy, matching what `signUpWithPassword` already enforced.
 *
 * Length only, and on purpose: composition rules ("one capital, one symbol") push people
 * toward `Password1!` and are worse than a length floor. Returns a message to show, or null.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 512) return "That password is unreasonably long.";
  return null;
}
