import { getDb } from "./client";
import { COLLECTIONS } from "./documents";

/**
 * Every constraint the SQL schema expressed in DDL, expressed here instead.
 *
 * This runs at startup and is idempotent, which replaces the migration-file workflow
 * entirely — and with it the whole class of problem `schemaStatus()` and `forWrite()` exist
 * to paper over in the Next.js app. There, the migrations are SQL files a human runs by hand,
 * so there is always a window where the code is ahead of the schema and reads have to
 * degrade and writes have to narrow. Here the code *is* the schema, applied before the first
 * request is served, so that window doesn't exist.
 *
 * Three mappings are worth naming, because they are the interesting part of the port:
 *
 *  - **A partial unique index replaces a partial unique index.** Postgres has
 *    `unique (account_id, kind) where account_id is not null`. A plain Mongo unique index
 *    would treat two `null`s as equal and reject the second project-owned secret, so the
 *    `$type: "string"` filter is doing real work, not decoration.
 *
 *  - **TTL indexes replace the housekeeping code.** `pruneExpiredSessions()` and the
 *    `delete … where created_at < now() - 90 days` at the end of `pingProjects()` are both
 *    just retention policies, and MongoDB enforces retention natively. The sweep no longer
 *    has to spend part of its budget deleting rows.
 *
 *  - **Nothing replaces RLS.** There is no index for that; ownership is enforced in code by
 *    `src/db/scope.ts`, which is the one place that can't be skipped.
 */

/** 90 days of ping history, the same retention the SQL sweep enforced by hand. */
const PING_LOG_RETENTION_DAYS = 90;
/** 400 days of usage history — enough for a year-over-year comparison, per docs/ARCHITECTURE.md §4. */
const USAGE_RETENTION_DAYS = 400;

const days = (n: number) => n * 24 * 60 * 60;

export async function ensureIndexes(): Promise<void> {
  const db = getDb();

  await db.collection(COLLECTIONS.users).createIndexes([
    { key: { email: 1 }, name: "users_email_unique", unique: true },
    // Partial, not sparse: an account that has never used Google has `google_sub: null`, and
    // a plain unique index would let only one such account exist.
    {
      key: { google_sub: 1 },
      name: "users_google_sub_unique",
      unique: true,
      partialFilterExpression: { google_sub: { $type: "string" } },
    },
  ]);

  await db.collection(COLLECTIONS.authSessions).createIndexes([
    { key: { token_hash: 1 }, name: "auth_sessions_token_unique", unique: true },
    { key: { user_id: 1 }, name: "auth_sessions_user" },
    // expireAfterSeconds: 0 means "delete when the date in this field passes".
    { key: { expires_at: 1 }, name: "auth_sessions_ttl", expireAfterSeconds: 0 },
  ]);

  await db.collection(COLLECTIONS.accounts).createIndexes([
    // `unique (user_id, provider, email)` — two people may each register the same account.
    {
      key: { user_id: 1, provider: 1, email: 1 },
      name: "accounts_user_provider_email_unique",
      unique: true,
    },
    { key: { user_id: 1, created_at: 1 }, name: "accounts_user_created" },
  ]);

  await db.collection(COLLECTIONS.projects).createIndexes([
    {
      key: { user_id: 1, provider: 1, external_id: 1 },
      name: "projects_user_provider_external_unique",
      unique: true,
    },
    { key: { user_id: 1, name: 1 }, name: "projects_user_name" },
    { key: { user_id: 1, account_id: 1 }, name: "projects_user_account" },
    // The sweep's query: every keep-alive project, optionally narrowed to one user.
    { key: { keep_alive: 1, provider: 1 }, name: "projects_keepalive_provider" },
  ]);

  await db.collection(COLLECTIONS.secrets).createIndexes([
    {
      key: { account_id: 1, kind: 1 },
      name: "secrets_account_kind_unique",
      unique: true,
      partialFilterExpression: { account_id: { $type: "string" } },
    },
    {
      key: { project_id: 1, kind: 1 },
      name: "secrets_project_kind_unique",
      unique: true,
      partialFilterExpression: { project_id: { $type: "string" } },
    },
    { key: { user_id: 1, tier: 1 }, name: "secrets_user_tier" },
    { key: { user_id: 1, kind: 1 }, name: "secrets_user_kind" },
  ]);

  await db.collection(COLLECTIONS.vaultSessions).createIndexes([
    { key: { token_hash: 1 }, name: "vault_sessions_token_unique", unique: true },
    { key: { user_id: 1 }, name: "vault_sessions_user" },
    { key: { expires_at: 1 }, name: "vault_sessions_ttl", expireAfterSeconds: 0 },
  ]);

  await db.collection(COLLECTIONS.otpChallenges).createIndexes([
    { key: { user_id: 1, purpose: 1, created_at: -1 }, name: "otp_user_purpose_created" },
    { key: { expires_at: 1 }, name: "otp_ttl", expireAfterSeconds: 0 },
  ]);

  await db.collection(COLLECTIONS.pingLogs).createIndexes([
    { key: { project_id: 1, created_at: -1 }, name: "ping_logs_project_created" },
    { key: { user_id: 1, created_at: -1 }, name: "ping_logs_user_created" },
    {
      key: { created_at: 1 },
      name: "ping_logs_retention_ttl",
      expireAfterSeconds: days(PING_LOG_RETENTION_DAYS),
    },
  ]);

  await db.collection(COLLECTIONS.usageSnapshots).createIndexes([
    // One reading per project, per metric, per UTC day: what makes a re-run of the sweep
    // replace today's number instead of stacking a second row next to it.
    {
      key: { project_id: 1, metric: 1, captured_on: 1 },
      name: "usage_daily_unique",
      unique: true,
    },
    { key: { project_id: 1, metric: 1, captured_at: -1 }, name: "usage_project_metric_captured" },
    { key: { user_id: 1 }, name: "usage_user" },
    {
      key: { captured_at: 1 },
      name: "usage_retention_ttl",
      expireAfterSeconds: days(USAGE_RETENTION_DAYS),
    },
  ]);

  await db.collection(COLLECTIONS.auditLog).createIndexes([
    { key: { user_id: 1, created_at: -1 }, name: "audit_user_created" },
  ]);
}

/** Printed by `pnpm indexes`, so the applied shape can be checked without a Mongo shell. */
export async function describeIndexes(): Promise<Record<string, string[]>> {
  const db = getDb();
  const out: Record<string, string[]> = {};
  for (const name of Object.values(COLLECTIONS)) {
    const list = await db.collection(name).listIndexes().toArray();
    out[name] = list.map((i) => i.name as string);
  }
  return out;
}
