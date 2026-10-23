import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { UserDoc } from "../db/documents";
import { scopeFor, type Scope } from "../db/scope";
import { unauthorized } from "../http/errors";
import { currentUser } from "./sessions";

/**
 * Authenticate a request, or reject it.
 *
 * This is the whole of what `middleware.ts` + `lib/supabase/middleware.ts` did in the
 * Next.js app, minus the part that doesn't apply: there, every request had to run through
 * `supabase.auth.getUser()` so an expiring access token could be refreshed and the new
 * cookies written onto whatever response was eventually returned — including redirects, which
 * is the subtle bit that file spends most of its length on. Opaque server-side sessions have
 * no token to refresh, so that machinery has no counterpart here.
 *
 * Route protection is per-route rather than by path prefix. The prefix list
 * (`PUBLIC_PREFIXES`) was a reasonable fit for a filesystem router where paths and pages
 * correspond; with an explicit route table, attaching the guard to the routes that need it
 * means a new route is unprotected only if someone writes it that way, not if they forget to
 * update a list somewhere else.
 */
export const requireUser: RequestHandler = (req, _res, next) => {
  void (async () => {
    const user = await currentUser(req);
    if (!user) {
      next(unauthorized());
      return;
    }
    req.auth = { user, scope: scopeFor(user._id) };
    next();
  })().catch(next);
};

/**
 * Read the authenticated context.
 *
 * Throws if it is missing, which can only happen if a route was mounted without
 * `requireUser` — a programming error, so it fails loudly in development rather than
 * silently serving unscoped data.
 */
export function auth(req: Request): { user: UserDoc; scope: Scope } {
  if (!req.auth) {
    throw new Error("This route reads req.auth but was mounted without requireUser.");
  }
  return req.auth;
}

/** Shorthand for the common case. */
export const scope = (req: Request): Scope => auth(req).scope;
export const userId = (req: Request): string => auth(req).user._id;

/** Attach the user when there is one, without rejecting anonymous requests. */
export const optionalUser: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  void (async () => {
    const user = await currentUser(req);
    if (user) req.auth = { user, scope: scopeFor(user._id) };
    next();
  })().catch(next);
};
