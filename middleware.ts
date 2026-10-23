import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { gateNodeBackend } from "@/lib/backend/middleware";
import { usingNodeBackend } from "@/lib/backend/env";

/**
 * Which gate runs depends on which backend owns identity.
 *
 * The Supabase path refreshes the access token and writes the new cookies onto the response.
 * The Node path checks for a session cookie and otherwise stays out of the way — it has no
 * token to refresh. Branching here rather than inside `updateSession` keeps the Supabase
 * module free of a backend it knows nothing about, and means a deployment on the Node backend
 * never needs the Supabase environment variables set at all.
 */
export async function middleware(req: NextRequest) {
  if (usingNodeBackend()) return gateNodeBackend(req);
  return updateSession(req);
}

export const config = {
  // Skip static assets and image files; everything else goes through session refresh so
  // tokens stay fresh even on pages that don't read the user.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
