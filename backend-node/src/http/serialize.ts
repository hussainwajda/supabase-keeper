import type {
  AccountDoc,
  AuditLogDoc,
  PingLogDoc,
  ProjectDoc,
  SecretDoc,
  UsageSnapshotDoc,
  UserDoc,
} from "../db/documents";

/**
 * Documents to JSON.
 *
 * Two jobs, both load-bearing:
 *
 *  1. **`_id` becomes `id`, and BSON `Date`s become ISO strings.** The payloads this produces
 *     match the Next.js app's own row types in `lib/registry/types.ts` field for field, so
 *     that file keeps describing the data whichever backend is serving it. That's what makes
 *     this backend a drop-in rather than a fork — the frontend's types are the API contract,
 *     and they were already written against ISO strings because PostgREST returns those.
 *
 *     (One honest deviation: `ping_logs.id`, `usage_snapshots.id` and `audit_log.id` were
 *     Postgres `bigint`s and are typed `number` in that file. Here they are UUID strings,
 *     for the reason in `src/db/ids.ts`. Nothing in the UI does arithmetic on them — they're
 *     React keys — but it is a difference, not a coincidence, so it's written down.)
 *
 *  2. **Secret ciphertext is dropped on the way out.** `toSecretSummary` has no branch that
 *     can include it. docs/SECURITY.md §6 forbids `select *` on that table for exactly this
 *     reason, and the equivalent discipline in a schemaless store is that the serialiser
 *     names its fields explicitly instead of spreading the document.
 */

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** `created_at` is `not null` in SQL, so it's never optional on the way out. */
const isoRequired = (d: Date): string => d.toISOString();

export function toAccount(doc: AccountDoc) {
  return {
    id: doc._id,
    user_id: doc.user_id,
    provider: doc.provider,
    email: doc.email,
    label: doc.label,
    login_method: doc.login_method,
    notes: doc.notes,
    last_synced_at: iso(doc.last_synced_at),
    last_sync_status: doc.last_sync_status,
    last_sync_error: doc.last_sync_error,
    created_at: isoRequired(doc.created_at),
  };
}

export function toProject(doc: ProjectDoc) {
  return {
    id: doc._id,
    user_id: doc.user_id,
    account_id: doc.account_id,
    provider: doc.provider,
    external_id: doc.external_id,
    name: doc.name,
    region: doc.region,
    plan: doc.plan,
    provider_status: doc.provider_status,
    lifecycle: doc.lifecycle,
    strategy: doc.strategy,
    keep_alive: doc.keep_alive,
    interval_days: doc.interval_days,
    repo_url: doc.repo_url,
    local_path: doc.local_path,
    notes: doc.notes,
    metadata: doc.metadata,
    last_pinged_at: iso(doc.last_pinged_at),
    last_status: doc.last_status,
    last_error: doc.last_error,
    discovered_at: iso(doc.discovered_at),
    created_at: isoRequired(doc.created_at),
  };
}

/** A project with its account embedded, matching `ProjectWithAccount`. */
export function toProjectWithAccount(doc: ProjectDoc, account: AccountDoc | null) {
  return { ...toProject(doc), account: account ? toAccount(account) : null };
}

export function toPingLog(doc: PingLogDoc) {
  return {
    id: doc._id,
    project_id: doc.project_id,
    status: doc.status,
    strategy: doc.strategy,
    via: doc.via,
    http_status: doc.http_status,
    duration_ms: doc.duration_ms,
    error: doc.error,
    created_at: isoRequired(doc.created_at),
  };
}

export function toUsageRow(doc: UsageSnapshotDoc) {
  return {
    id: doc._id,
    project_id: doc.project_id,
    metric: doc.metric,
    value: doc.value,
    limit_value: doc.limit_value,
    unit: doc.unit,
    period_start: iso(doc.period_start),
    period_end: iso(doc.period_end),
    captured_at: isoRequired(doc.captured_at),
    captured_on: doc.captured_on,
  };
}

/**
 * The only shape a secret may leave the process in. `ciphertext` is absent by construction,
 * not by omission — reveal is a separate, audited endpoint.
 */
export function toSecretSummary(doc: SecretDoc) {
  return {
    id: doc._id,
    kind: doc.kind,
    label: doc.label,
    tier: doc.tier,
    account_id: doc.account_id,
    project_id: doc.project_id,
    last_used_at: iso(doc.last_used_at),
    created_at: isoRequired(doc.created_at),
    updated_at: isoRequired(doc.updated_at),
  };
}

export function toAuditRow(doc: AuditLogDoc) {
  return {
    id: doc._id,
    action: doc.action,
    target_type: doc.target_type,
    target_id: doc.target_id,
    method: doc.method,
    ip: doc.ip,
    user_agent: doc.user_agent,
    detail: doc.detail,
    created_at: isoRequired(doc.created_at),
  };
}

/**
 * The signed-in user, for `GET /auth/me`.
 *
 * `password_hash`, `dek_pin`, `dek_srv` and `pin_salt` are all on the user document now that
 * this backend owns identity, and none of them has any business leaving it — the wrapped DEKs
 * especially, since `dek_pin` is precisely the thing an offline PIN attack needs.
 */
export function toCurrentUser(doc: UserDoc) {
  return {
    id: doc._id,
    email: doc.email,
    display_name: doc.display_name,
    avatar_url: doc.avatar_url,
    has_password: doc.password_hash !== null,
    google_linked: doc.google_sub !== null,
    created_at: isoRequired(doc.created_at),
  };
}
