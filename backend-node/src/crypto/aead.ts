import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM, with everything needed to decrypt packed into one self-describing blob:
 *
 *   [version:1][iv:12][ciphertext][tag:16]
 *
 * stored base64 in a `text` column. Two deliberate choices:
 *
 *  - **One blob, not separate ciphertext/iv columns.** Nothing can get half-updated, and
 *    there's no way to pair the wrong IV with a ciphertext.
 *  - **base64 text, not `bytea`.** PostgREST represents bytea as `\x…` hex strings over
 *    JSON, which is one more encoding layer to get wrong in both directions. base64 text is
 *    unambiguous end to end and costs ~33% on blobs that are a few hundred bytes.
 */
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Additional authenticated data binds a blob to the row it belongs to, so a ciphertext
 * cannot be copied from one user (or one secret kind) to another and still decrypt.
 */
export function aad(...parts: (string | null | undefined)[]): Buffer {
  return Buffer.from(parts.map((p) => p ?? "").join("\u0000"), "utf8");
}

export function seal(key: Buffer, plaintext: string | Buffer, context?: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (context) cipher.setAAD(context);

  const body = Buffer.concat([
    cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext),
    cipher.final(),
  ]);

  return Buffer.concat([Buffer.from([VERSION]), iv, body, cipher.getAuthTag()]).toString("base64");
}

/**
 * Returns null when the blob doesn't authenticate — a wrong key, a wrong PIN, a tampered
 * row, or a blob moved between rows. The GCM tag is the only verifier, which is why no
 * separate PIN hash is stored for an attacker to work on.
 */
export function open(key: Buffer, envelope: string, context?: Buffer): Buffer | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(envelope, "base64");
  } catch {
    return null;
  }
  if (buf.length < 1 + IV_BYTES + TAG_BYTES) return null;
  if (buf[0] !== VERSION) return null;

  const iv = buf.subarray(1, 1 + IV_BYTES);
  const body = buf.subarray(1 + IV_BYTES, buf.length - TAG_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    if (context) decipher.setAAD(context);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
}

export function openToString(key: Buffer, envelope: string, context?: Buffer): string | null {
  const out = open(key, envelope, context);
  return out ? out.toString("utf8") : null;
}

/** Constant-time compare for hashes and tokens of equal length. */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
