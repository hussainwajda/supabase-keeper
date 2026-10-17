import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { registryAnonKey, registryConfigured, registryUrl } from "./env";

/**
 * Per-request client carrying the signed-in user's JWT.
 *
 * This is the default path for every read and write: queries run as the user, so RLS is
 * enforced by Postgres rather than by remembering to add `.eq("user_id", …)` everywhere.
 */
export async function supabaseServer(): Promise<SupabaseClient> {
  const jar = await cookies();

  return createServerClient(registryUrl(), registryAnonKey(), {
    cookies: {
      getAll() {
        return jar.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            jar.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only. The middleware
          // refreshes the session instead, so this is safe to swallow.
        }
      },
    },
  });
}

/**
 * The signed-in user, or null.
 *
 * Returns null rather than throwing when the registry env is incomplete, so the root layout
 * and the /setup page still render on a fresh clone. The middleware is what actually gates
 * access, so a null here can never expose anything.
 */
export async function currentUser() {
  if (!registryConfigured()) return null;
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
