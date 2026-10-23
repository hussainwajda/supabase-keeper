import type { NextFunction, Request, Response } from "express";
import { corsOrigins } from "../config/env";

/**
 * CORS for a credentialed, cross-origin frontend.
 *
 * The Next.js app never needed this: its server actions run in the same origin as the pages.
 * Split the backend out and the browser starts enforcing CORS on every call, with one
 * sharp edge — `Access-Control-Allow-Origin: *` is rejected outright when the request sends
 * credentials, and cookie auth always does. So the allowed origin is echoed back from a
 * configured list, which also means an origin nobody configured gets no header at all rather
 * than a quiet wildcard.
 */
export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  const allowed = corsOrigins();

  if (origin && allowed.includes(origin.replace(/\/$/, ""))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    // Caches must not serve one origin's response to another.
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}
