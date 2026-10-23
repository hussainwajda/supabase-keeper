/**
 * The shape of a one-shot message, and the cookie it travels in.
 *
 * Deliberately free of imports. The writer (`lib/flash-server.ts`) needs `next/headers` and
 * the reader is a client component, so anything they share has to be safe in both bundles —
 * pulling `server-only` in here would break the client build, which is exactly what it did.
 */

export type FlashTone = "success" | "error" | "info";

export type Flash = {
  message: string;
  tone: FlashTone;
  description?: string;
};

export const FLASH_COOKIE = "ks_flash";
