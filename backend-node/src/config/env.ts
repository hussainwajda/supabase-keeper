/**
 * Environment for the Node + MongoDB backend.
 *
 * Deliberately the same shape of contract as the Next.js app's `lib/supabase/env.ts`: ask
 * for a value and either get it or get a message that says what to do. The difference is
 * what's required — there is no Supabase URL, anon key or service-role key here, because
 * this backend holds its own identity and its own data.
 */

function required(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got "${raw}".`);
  return parsed;
}

export const isProduction = (): boolean => process.env.NODE_ENV === "production";

// ─── MongoDB ──────────────────────────────────────────────────────────────────

export function mongoUri(): string {
  return required(
    "MONGODB_URI",
    "Point it at your MongoDB deployment, e.g. mongodb://127.0.0.1:27017 locally or an Atlas mongodb+srv:// string.",
  );
}

/** The database name. Kept separate from the URI so one cluster can host dev and prod. */
export function mongoDbName(): string {
  return optional("MONGODB_DB") ?? "keepstack";
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

export const port = (): number => int("PORT", 4000);

/**
 * Origins allowed to send credentialed requests.
 *
 * Cookie auth across origins needs an explicit origin echoed back — `*` is rejected by
 * browsers when `credentials: include` is set — so this is a list, not a wildcard.
 */
export function corsOrigins(): string[] {
  const raw = optional("CORS_ORIGIN") ?? "http://localhost:3000";
  return raw
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/** This backend's own public base URL, used to build the Google OAuth redirect URI. */
export function publicUrl(): string {
  return (optional("PUBLIC_URL") ?? `http://localhost:${port()}`).replace(/\/$/, "");
}

/** Where to send the browser after an OAuth round trip — the frontend, not this API. */
export function appUrl(): string {
  return (optional("APP_URL") ?? corsOrigins()[0] ?? "http://localhost:3000").replace(/\/$/, "");
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export const sessionTtlDays = (): number => int("SESSION_TTL_DAYS", 30);

/**
 * `secure` cookies are HTTPS-only, so they are on in production and off locally — otherwise
 * nothing would ever log in over plain http://localhost.
 *
 * `sameSite` has to be `none` for a cross-site frontend, and `none` requires `secure`. The
 * local default of `lax` works because the dev frontend and this API are both on localhost.
 */
export function cookieOptions(): { secure: boolean; sameSite: "lax" | "none"; domain?: string } {
  const crossSite = process.env.COOKIE_SAMESITE === "none";
  const secure = process.env.COOKIE_SECURE === "true" || isProduction() || crossSite;
  const domain = optional("COOKIE_DOMAIN");
  return { secure, sameSite: crossSite ? "none" : "lax", ...(domain ? { domain } : {}) };
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/** Shared secret for /api/cron/sweep, exactly as the Next.js app's cron route uses it. */
export const cronSecret = (): string | null => optional("CRON_SECRET");

/**
 * Run the sweep from inside this process instead of relying on an external cron.
 *
 * The Next.js app can't do this — a serverless function has no process to hold an interval —
 * which is why it needs Vercel Cron. A long-lived Node server can, so self-hosters get the
 * scheduler for free and nothing external has to be configured.
 */
export const schedulerEnabled = (): boolean => process.env.ENABLE_SCHEDULER === "true";

export const schedulerIntervalHours = (): number => int("SCHEDULER_INTERVAL_HOURS", 24);

// ─── Google OAuth (optional) ──────────────────────────────────────────────────

export function googleOauth(): { clientId: string; clientSecret: string } | null {
  const clientId = optional("GOOGLE_CLIENT_ID");
  const clientSecret = optional("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export const googleEnabled = (): boolean => googleOauth() !== null;

export const googleRedirectUri = (): string => `${publicUrl()}/auth/google/callback`;

// ─── Signup policy ────────────────────────────────────────────────────────────

/**
 * Self-hosted deployments are usually for one person, so leaving signup open by default
 * would be the wrong trade. Set `ALLOW_SIGNUP=true` to open it, or seed the single user with
 * the migration script.
 */
export const signupAllowed = (): boolean => process.env.ALLOW_SIGNUP === "true";
