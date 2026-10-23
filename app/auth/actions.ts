"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { currentUser } from "@/lib/backend/user";
import { lockVault } from "@/lib/vault/session";
import { usingNodeBackend } from "@/lib/backend/env";
import { ApiError } from "@/lib/backend/client";
import * as api from "@/lib/backend/api";

/** The site's own origin, used to build OAuth and email redirect URLs. */
async function siteOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/$/, "");

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Result shape for the login form: an error to fix, or a notice to read. */
export type AuthResult = { error: string | null; notice: string | null };

const fail = (error: string): AuthResult => ({ error, notice: null });
const notify = (notice: string): AuthResult => ({ error: null, notice });

function safePath(value: FormDataEntryValue | null): string {
  const s = typeof value === "string" ? value : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

/**
 * Start Google OAuth. Run on the server so the redirect URL is built from the real request
 * origin rather than whatever the browser thinks it is.
 */
export async function signInWithGoogle(_: AuthResult | null, fd: FormData): Promise<AuthResult> {
  /*
   * Not available on the Node backend, and the reason is structural rather than missing work.
   *
   * `backend-node` implements the Google code flow itself and sets its session cookie on its
   * own host. In this deployment the browser only ever talks to Next.js, so a cookie scoped to
   * the API's host never reaches it — the user would complete the consent screen and land back
   * signed out. Proxying the whole flow through Next.js would mean re-implementing the
   * redirect, state and token exchange a second time here, which is a real feature rather
   * than a shim, so the button is hidden instead of being left to fail.
   *
   * Google sign-in does work against `backend-node` directly, for a client that calls it
   * without this proxy in front.
   */
  if (usingNodeBackend()) {
    return fail(
      "Google sign-in isn't available when Keepstack is running on the Node backend. Use your email and password.",
    );
  }

  const supabase = await supabaseServer();
  const next = safePath(fd.get("next"));
  const origin = await siteOrigin();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      queryParams: { access_type: "offline", prompt: "consent" },
    },
  });

  if (error) return fail(error.message);
  if (!data.url) return fail("Google sign-in did not return a redirect URL.");
  // `redirect` throws, so nothing after this runs — the return type keeps TypeScript happy.
  redirect(data.url);
}

export async function signInWithPassword(_: AuthResult | null, fd: FormData): Promise<AuthResult> {
  const email = String(fd.get("email") ?? "").trim();
  const password = String(fd.get("password") ?? "");
  if (!email || !password) return fail("Enter both an email and a password.");

  if (usingNodeBackend()) {
    try {
      // The API answers with a session cookie for its own host; `apiPost` re-issues it on this
      // origin. See the note on cookie relaying in lib/backend/client.ts.
      await api.login(email, password);
    } catch (e) {
      if (e instanceof ApiError) return fail(e.message);
      throw e;
    }
    redirect(safePath(fd.get("next")));
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return fail(error.message);

  redirect(safePath(fd.get("next")));
}

export async function signUpWithPassword(_: AuthResult | null, fd: FormData): Promise<AuthResult> {
  const email = String(fd.get("email") ?? "").trim();
  const password = String(fd.get("password") ?? "");
  if (!email || !password) return fail("Enter both an email and a password.");
  if (password.length < 8) return fail("Use at least 8 characters.");

  if (usingNodeBackend()) {
    try {
      await api.signup(email, password);
    } catch (e) {
      if (e instanceof ApiError) return fail(e.message);
      throw e;
    }
    // No email confirmation step on this backend, so signup signs you straight in.
    redirect("/");
  }

  const supabase = await supabaseServer();
  const origin = await siteOrigin();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${origin}/auth/confirm?next=/` },
  });
  if (error) return fail(error.message);

  // With email confirmation on there is a user but no session yet — that is a notice, not an
  // error, and the form must not render it in red.
  if (data.user && !data.session) {
    return notify(`Check ${email} for a confirmation link, then sign in.`);
  }
  redirect("/");
}

export async function signOut() {
  if (usingNodeBackend()) {
    // The API closes the vault before the session for the same reason the Supabase branch
    // below does, so one call covers both — and it clears both cookies, which `apiPost`
    // relays back as deletions.
    await api.logout().catch(() => undefined);
    redirect("/login");
  }

  // Close the vault first: a sealed-DEK row and its cookie must not outlive the session that
  // opened them. Cross-user reuse is already impossible (the row is bound to a user id), but
  // leaving either behind is needless exposure.
  const user = await currentUser();
  if (user) {
    try {
      await lockVault(user.id);
    } catch {
      // Never block sign-out on vault cleanup; the session expires on its own regardless.
    }
  }

  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/login");
}
