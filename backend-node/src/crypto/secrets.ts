import { aad, openToString, seal } from "./aead";
import { masterKey } from "./env";

/**
 * Secret-value encryption, one function per tier (docs/SECURITY.md §1).
 *
 * The AAD binds every blob to its owner, kind and tier, so a ciphertext cannot be moved
 * between rows — including from a `personal` row to a `server` row, which would otherwise be
 * a way to get the server to decrypt something it shouldn't be able to.
 */
export type SecretTier = "server" | "personal";

function context(userId: string, kind: string, tier: SecretTier): Buffer {
  return aad("keepstack/secret/v1", userId, kind, tier);
}

/** Server tier: readable by the nightly sweep, unattended. */
export function sealServerSecret(value: string, userId: string, kind: string): string {
  return seal(masterKey(), value, context(userId, kind, "server"));
}

export function openServerSecret(
  envelope: string,
  userId: string,
  kind: string,
): string | null {
  return openToString(masterKey(), envelope, context(userId, kind, "server"));
}

/** Personal tier: needs the user's unwrapped DEK, i.e. a live vault session. */
export function sealPersonalSecret(
  value: string,
  dek: Buffer,
  userId: string,
  kind: string,
): string {
  return seal(dek, value, context(userId, kind, "personal"));
}

export function openPersonalSecret(
  envelope: string,
  dek: Buffer,
  userId: string,
  kind: string,
): string | null {
  return openToString(dek, envelope, context(userId, kind, "personal"));
}
