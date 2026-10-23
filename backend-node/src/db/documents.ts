import type { Lifecycle, ProviderId, Strategy } from "../providers/types";

/**
 * The document shapes, one collection per table in `supabase/migrations/`.
 *
 * Three rules hold across all of them, and they are what replace the three Postgres features
 * MongoDB doesn't have:
 *
 *  1. **`_id` is a UUID string, never an ObjectId.** The migration from Postgres carries the
 *     existing primary keys over verbatim, and it has to: every secret's ciphertext and both
 *     wrapped copies of a user's DEK are sealed with AAD that includes the user id
 *     (`src/crypto/secrets.ts`, `src/crypto/dek.ts`). Mint a new id for a user and every
 *     secret they own becomes undecryptable, permanently. So ids are preserved, not reissued.
 *
 *  2. **Dates are BSON `Date`, not ISO strings.** Range queries, sorts and TTL indexes all
 *     need real dates. Strings are produced only at the API boundary, by `src/http/serialize.ts`,
 *     so the JSON this backend returns still matches the Next.js app's `lib/registry/types.ts`.
 *
 *  3. **Child documents carry `user_id`.** In Postgres, `ping_logs` and `usage_snapshots` are
 *     reached through a policy that joins to `projects`. Without RLS there is no policy to
 *     join, so the owner is denormalised onto the row and every query filters on it directly.
 *     See `src/db/scope.ts` for why that is enforced rather than remembered.
 */

/** Replaces `auth.users` + `public.profiles`, which were only ever split because Auth owned one of them. */
export type UserDoc = {
  /** A UUID — the same one Supabase Auth issued, for migrated accounts. */
  _id: string;
  /** Lowercased and unique. The login identifier. */
  email: string;
  /** Null for an account that only ever signed in with Google. */
  password_hash: string | null;
  display_name: string | null;
  avatar_url: string | null;
  /** Google's stable subject id, set on first Google sign-in. Unique when present. */
  google_sub: string | null;
  /** The vault columns, straight off the old `profiles` row. See docs/SECURITY.md §2. */
  vault_initialized_at: Date | null;
  pin_salt: string | null;
  dek_pin: string | null;
  dek_srv: string | null;
  pin_failed_attempts: number;
  pin_locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * Dashboard login sessions.
 *
 * New in this backend: Supabase Auth owned this, and owned the cookie-refresh dance in
 * `lib/supabase/middleware.ts` with it. Same approach as the vault's own sessions — the raw
 * token lives only in the browser's cookie, and only its SHA-256 is stored here.
 */
export type AuthSessionDoc = {
  _id: string;
  user_id: string;
  token_hash: string;
  ip: string | null;
  user_agent: string | null;
  expires_at: Date;
  created_at: Date;
};

export type AccountDoc = {
  _id: string;
  user_id: string;
  provider: ProviderId;
  email: string;
  label: string | null;
  login_method: string | null;
  notes: string | null;
  last_synced_at: Date | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  created_at: Date;
};

export type ProjectDoc = {
  _id: string;
  user_id: string;
  account_id: string | null;
  provider: ProviderId;
  external_id: string;
  name: string;
  region: string | null;
  plan: string | null;
  provider_status: string | null;
  lifecycle: Lifecycle;
  strategy: Strategy;
  keep_alive: boolean;
  interval_days: number;
  repo_url: string | null;
  local_path: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  last_pinged_at: Date | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  discovered_at: Date | null;
  created_at: Date;
};

/**
 * One collection, polymorphic owner — the same decision as the SQL schema, for the same
 * reason: two near-identical collections would mean two code paths in the vault UI.
 */
export type SecretDoc = {
  _id: string;
  user_id: string;
  account_id: string | null;
  project_id: string | null;
  kind: string;
  label: string | null;
  tier: "server" | "personal";
  /** base64 envelope: [version:1][iv:12][ciphertext][gcm tag:16]. Never logged, never exported. */
  ciphertext: string;
  key_version: number;
  last_used_at: Date | null;
  last_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type VaultSessionDoc = {
  _id: string;
  user_id: string;
  token_hash: string;
  dek_sealed: string;
  method: "pin" | "otp";
  ip: string | null;
  user_agent: string | null;
  expires_at: Date;
  created_at: Date;
};

export type OtpChallengeDoc = {
  _id: string;
  user_id: string;
  code_hash: string;
  purpose: "vault_unlock" | "pin_reset";
  attempts: number;
  consumed_at: Date | null;
  expires_at: Date;
  created_at: Date;
};

export type PingLogDoc = {
  _id: string;
  project_id: string;
  /** Denormalised owner — see rule 3 above. */
  user_id: string;
  status: string;
  strategy: Strategy;
  via: string | null;
  http_status: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: Date;
  /** The Postgres `bigint` id, kept by the migration so a row can be traced back. */
  legacy_id?: number;
};

export type UsageSnapshotDoc = {
  _id: string;
  project_id: string;
  user_id: string;
  metric: string;
  value: number;
  limit_value: number | null;
  unit: string;
  period_start: Date | null;
  period_end: Date | null;
  captured_at: Date;
  /**
   * The UTC calendar day as `YYYY-MM-DD`, written by the application.
   *
   * Kept as a plain string for the same reason migration 0007 keeps it a plain column: the
   * daily uniqueness guarantee has to be an index the upsert can name, and deriving the day
   * inside the index would make it depend on a timezone. A string the app computes carries
   * no volatility question at all.
   */
  captured_on: string;
  legacy_id?: number;
};

export type AuditLogDoc = {
  _id: string;
  user_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  method: string | null;
  ip: string | null;
  user_agent: string | null;
  detail: Record<string, unknown>;
  created_at: Date;
  legacy_id?: number;
};

/** Collection names in one place, so a typo is a compile error rather than an empty result. */
export const COLLECTIONS = {
  users: "users",
  authSessions: "auth_sessions",
  accounts: "accounts",
  projects: "projects",
  secrets: "secrets",
  vaultSessions: "vault_sessions",
  otpChallenges: "otp_challenges",
  pingLogs: "ping_logs",
  usageSnapshots: "usage_snapshots",
  auditLog: "audit_log",
} as const;
