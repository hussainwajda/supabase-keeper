import "server-only";
import { cache } from "react";
import { usingNodeBackend } from "./env";
import { ApiError } from "./client";
import * as api from "./api";
import { supabaseServer } from "@/lib/supabase/server";
import { registryConfigured } from "@/lib/supabase/env";

/**
 * The signed-in user, from whichever backend is active.
 *
 * Normalised to the four fields the app actually reads, rather than passing a Supabase `User`
 * around. That matters more than it looks: `app/layout.tsx` used to reach into
 * `user.user_metadata.full_name`, which is a Supabase-Auth-shaped detail, and anything that
 * reads it can only ever work on one backend.
 */
export type SessionUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

/**
 * Returns null when nobody is signed in, and **throws** when the backend can't be reached.
 *
 * The distinction is deliberate. Treating an unreachable API as "signed out" would redirect
 * to /login and quietly blame the user for an outage — and they'd sign in successfully and
 * bounce straight back. A thrown error says what's actually wrong. This matches the Supabase
 * path, where an unreachable Postgres also surfaces as an error rather than an empty session.
 */
// Deduped per request: the root layout and the page inside it both ask who is signed in,
// and that was two round trips on every navigation.
export const currentUser = cache(async function currentUser(): Promise<SessionUser | null> {
  if (usingNodeBackend()) {
    try {
      const { user } = await api.me();
      return {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
      };
    } catch (e) {
      if (e instanceof ApiError && e.isUnauthorized) return null;
      throw e;
    }
  }

  // Null rather than a throw when the registry env is incomplete, so the root layout and the
  // /setup page still render on a fresh clone.
  if (!registryConfigured()) return null;

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
  return {
    id: user.id,
    email: user.email ?? null,
    displayName:
      (metadata.full_name as string | undefined) ??
      (metadata.name as string | undefined) ??
      user.email ??
      null,
    avatarUrl: (metadata.avatar_url as string | undefined) ?? null,
  };
});

/** The id alone, for the many callers that only need it. */
export async function currentUserId(): Promise<string | null> {
  return (await currentUser())?.id ?? null;
}
