import type { Request, Response } from "express";
import { cookieOptions } from "../config/env";

/**
 * Cookie reading and writing, without a dependency.
 *
 * `cookie-parser` is three lines of work for a package, and this backend keeps its runtime
 * dependencies to the two that earn their place (`express`, `mongodb`) — a service whose job
 * is holding other people's credentials is the wrong place to be casual about what ends up
 * in `node_modules`.
 */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Set an httpOnly cookie.
 *
 * httpOnly is the point: a session token or a vault token readable from JavaScript is one
 * XSS away from being someone else's. Same flags the Next.js app sets in
 * `lib/vault/session.ts`, with `secure` and `sameSite` driven by the environment so a
 * cross-origin deployment works without editing code.
 */
export function setCookie(res: Response, name: string, value: string, expires: Date): void {
  res.cookie(name, value, {
    httpOnly: true,
    path: "/",
    expires,
    ...cookieOptions(),
  });
}

export function clearCookie(res: Response, name: string): void {
  const { secure, sameSite, domain } = cookieOptions();
  res.clearCookie(name, { httpOnly: true, path: "/", secure, sameSite, ...(domain ? { domain } : {}) });
}
