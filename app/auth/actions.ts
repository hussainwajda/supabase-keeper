"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseServer, currentUser } from "@/lib/supabase/server";
import { lockVault } from "@/lib/vault/session";

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
