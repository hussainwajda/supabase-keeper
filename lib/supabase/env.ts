/**
 * Registry connection details, with clear errors rather than a cryptic failure deep in a
 * query. `NEXT_PUBLIC_SUPABASE_URL` is preferred; `SUPABASE_URL` is accepted so an existing
 * supabase-keeper deployment keeps working after upgrading.
 */
export function registryUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is not set. Point it at the Supabase project that holds Keepstack's own tables.",
    );
  }
  return url;
}

/** The anon / publishable key. Safe for the browser — RLS is what protects the data. */
export function registryAnonKey(): string {
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Copy the anon (publishable) key from your registry project's API settings — not the service_role key.",
    );
  }
  return key;
}

export function registryServiceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set.");
  return key;
}

/**
 * Which required environment variables are missing.
 *
 * Checked before anything tries to build a client, so a fresh clone gets an actionable
 * setup screen instead of a stack trace on every request.
 */
export function missingRegistryEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL && !process.env.SUPABASE_URL) {
    missing.push("NEXT_PUBLIC_SUPABASE_URL");
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  return missing;
}

export function registryConfigured(): boolean {
  return missingRegistryEnv().length === 0;
}

/** True when the one-time legacy claim path is deliberately enabled. */
export function legacyClaimAllowed(): boolean {
  return process.env.KEEPSTACK_ALLOW_LEGACY_CLAIM === "true";
}

/**
 * Optionally pin the claim to one account.
 *
 * Without this, the flag lets *whoever signs in* take the unowned rows. On a self-hosted
 * deployment that's you by definition, but if the app is reachable while the flag is on, this
 * closes the window. Set it to the email you intend to claim with.
 */
export function legacyClaimEmail(): string | null {
  const email = process.env.KEEPSTACK_LEGACY_CLAIM_EMAIL?.trim().toLowerCase();
  return email || null;
}
