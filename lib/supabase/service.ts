import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { registryServiceKey, registryUrl } from "./env";

let cached: SupabaseClient | null = null;

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * Only two things may use this:
 *   1. the nightly sweep, which has no user session to act under and must span all users;
 *   2. the one-time legacy claim, which is the only operation allowed to assign ownership.
 *
 * Everything else goes through `supabaseServer()` so Postgres enforces the boundary.
 */
export function supabaseService(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(registryUrl(), registryServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
