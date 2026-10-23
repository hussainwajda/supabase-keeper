import type { NextFunction, Request, RequestHandler, Response } from "express";
import { badRequest } from "./errors";

/**
 * Forward a rejected promise to the error handler.
 *
 * Express 5 does this for async handlers on its own, so this is belt and braces — it keeps
 * the routes readable and means they behave identically if the app is ever pinned back to
 * Express 4, where an unhandled rejection in a handler hangs the request instead.
 */
export function handler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

/** The client's IP and user agent, recorded on sessions and audit entries. */
export function requestOrigin(req: Request): { ip: string | null; userAgent: string | null } {
  const forwarded = req.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = header?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
  return { ip, userAgent: req.get("user-agent") ?? null };
}

/**
 * Read a single path parameter.
 *
 * Express 5 types `req.params` values as `string | string[]`, because a route pattern may
 * bind the same name more than once. None of these routes do, so rather than casting at two
 * dozen call sites this collapses the union in one place — and validates while it's there,
 * which a cast would not have done.
 */
export function param(req: Request, name: string): string {
  const raw = (req.params as Record<string, string | string[] | undefined>)[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw badRequest(`Missing :${name} in the request path.`);
  return value;
}
