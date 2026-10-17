import "server-only";
import { db } from "./client";
import type { Account, PingLog, Project, ProjectWithAccount } from "./types";

/**
 * Normalise a row read from either schema version.
 *
 * Migration 0002 is additive, but it's a SQL file the user runs by hand — so between
 * deploying Phase 0 and running it, these columns don't exist yet. Reads degrade to the
 * pre-0002 shape (every project is Supabase, `external_id` comes from `ref`) so the
 * dashboard still renders. Writes genuinely need the new columns; `schemaStatus()` below
 * surfaces that as a banner instead of a 500.
 */
function normalizeProject(row: Record<string, unknown>): Project {
  const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
  return {
    ...row,
    provider: (row.provider as Project["provider"]) ?? "supabase",
    external_id: (row.external_id as string) ?? (row.ref as string) ?? "",
    metadata,
    lifecycle: (row.lifecycle as Project["lifecycle"]) ?? "unknown",
    strategy: (row.strategy as Project["strategy"]) ?? "ping",
    provider_status: (row.provider_status as string | null) ?? null,
    region: (row.region as string | null) ?? null,
    plan: (row.plan as string | null) ?? null,
    discovered_at: (row.discovered_at as string | null) ?? null,
  } as Project;
}

function normalizeAccount(row: Record<string, unknown>): Account {
  return {
    ...row,
    provider: (row.provider as Account["provider"]) ?? "supabase",
    last_synced_at: (row.last_synced_at as string | null) ?? null,
    last_sync_status: (row.last_sync_status as string | null) ?? null,
    last_sync_error: (row.last_sync_error as string | null) ?? null,
  } as Account;
}

export async function listAccounts(): Promise<Account[]> {
  const { data, error } = await db().from("accounts").select("*").order("created_at");
  if (error) throw error;
  return (data as Record<string, unknown>[]).map(normalizeAccount);
}

export async function listProjects(): Promise<ProjectWithAccount[]> {
  const { data, error } = await db()
    .from("projects")
    .select("*, account:accounts(*)")
    .order("name");
  if (error) throw error;

  return (data as Record<string, unknown>[]).map((row) => {
    const { account, ...rest } = row;
    return {
      ...normalizeProject(rest),
      account: account ? normalizeAccount(account as Record<string, unknown>) : null,
    };
  });
}

export async function getProject(id: string): Promise<ProjectWithAccount | null> {
  const { data, error } = await db()
    .from("projects")
    .select("*, account:accounts(*)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { account, ...rest } = data as Record<string, unknown>;
  return {
    ...normalizeProject(rest),
    account: account ? normalizeAccount(account as Record<string, unknown>) : null,
  };
}

export async function recentLogs(projectId: string, limit = 15): Promise<PingLog[]> {
  const { data, error } = await db()
    .from("ping_logs")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as Record<string, unknown>[]).map((l) => ({
    ...l,
    strategy: (l.strategy as PingLog["strategy"]) ?? "ping",
    via: (l.via as string | null) ?? null,
  })) as PingLog[];
}

/** Every project with keep-alive enabled, for the nightly sweep. */
export async function keepAliveProjects(): Promise<Project[]> {
  const { data, error } = await db().from("projects").select("*").eq("keep_alive", true);
  if (error) throw error;
  return (data as Record<string, unknown>[]).map(normalizeProject);
}

/**
 * Has migration 0002 been applied?
 *
 * Probes for one of the new columns. Cached per process — the answer only changes when the
 * user runs the SQL, and a stale `false` costs one banner until the next cold start.
 */
let migrationApplied: boolean | null = null;

export async function schemaStatus(): Promise<{ migration0002: boolean }> {
  if (migrationApplied !== null) return { migration0002: migrationApplied };
  const { error } = await db().from("projects").select("provider,external_id,metadata").limit(1);
  // 42703 = undefined_column. Any other error is a real problem and should surface elsewhere.
  migrationApplied = !(error && error.code === "42703");
  return { migration0002: migrationApplied };
}

/** Slots used per account, for the free-tier counters. */
export function slotsUsed(projects: { account_id: string | null }[]): Record<string, number> {
  const used: Record<string, number> = {};
  for (const p of projects) {
    if (p.account_id) used[p.account_id] = (used[p.account_id] ?? 0) + 1;
  }
  return used;
}

/**
 * Full registry export. The safety net that has to exist before any risky migration —
 * secrets are deliberately excluded, so this file is safe to keep on disk.
 */
export async function exportRegistry() {
  const [accounts, projects] = await Promise.all([listAccounts(), listProjects()]);
  const { data: logs, error } = await db()
    .from("ping_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) throw error;

  return {
    keepstack_export_version: 1,
    exported_at: new Date().toISOString(),
    note: "Secrets (anon keys, tokens, passwords) are intentionally excluded from exports.",
    accounts,
    projects: projects.map(({ anon_key, account, ...p }) => ({ ...p, has_key: !!anon_key })),
    ping_logs: logs,
  };
}

/** Columns that only exist after migration 0002. */
const POST_0002_COLUMNS = {
  projects: [
    "provider",
    "external_id",
    "metadata",
    "provider_status",
    "lifecycle",
    "strategy",
    "region",
    "plan",
    "discovered_at",
  ],
  accounts: ["provider", "last_synced_at", "last_sync_status", "last_sync_error"],
  ping_logs: ["strategy", "via"],
} as const;

/**
 * Drop the post-0002 columns from a write when the migration hasn't been applied yet.
 *
 * Without this, Phase 0 would break the one thing that already worked — pinging — by
 * inserting a `strategy` column that doesn't exist. Reads normalise, writes narrow, and the
 * dashboard banner tells the user how to get the full feature set.
 */
export async function forWrite<T extends Record<string, unknown>>(
  table: keyof typeof POST_0002_COLUMNS,
  row: T,
): Promise<Partial<T>> {
  const { migration0002 } = await schemaStatus();
  if (migration0002) return row;
  const drop = new Set<string>(POST_0002_COLUMNS[table]);
  return Object.fromEntries(Object.entries(row).filter(([k]) => !drop.has(k))) as Partial<T>;
}
