import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { usingNodeBackend } from "@/lib/backend/env";
import * as api from "@/lib/backend/api";
import type { Account, PingLog, Project, ProjectWithAccount } from "./types";

/**
 * Two backends, one set of function signatures.
 *
 * Each exported read below starts by asking which backend is active and, under
 * `KEEPSTACK_BACKEND=node`, hands off to the REST client instead of querying Postgres. The
 * dispatch lives here rather than at the call sites on purpose: there are ~36 of them across
 * the pages and actions, and none of them has any business knowing where the data comes from.
 * `app/page.tsx` still just calls `listProjects()`.
 *
 * The `db?: SupabaseClient` parameter is ignored in node mode. It exists so the two
 * service-role callers (the sweep and the legacy claim) can bypass RLS, and neither concept
 * applies to the Node backend — it has no RLS to bypass, and its own sweep runs in-process.
 */

/**
 * Every read and write below runs as the signed-in user by default, so RLS in Postgres is
 * what scopes the data — not a `.eq("user_id", …)` we might forget. The service client is
 * passed explicitly by the two callers that genuinely need to bypass RLS: the nightly sweep
 * and the one-time legacy claim.
 */
async function client(override?: SupabaseClient): Promise<SupabaseClient> {
  return override ?? (await supabaseServer());
}

/**
 * Normalise a row read from either schema version.
 *
 * Migration 0002 is additive, but it's a SQL file the user runs by hand — so between
 * deploying and running it, these columns don't exist yet. Reads degrade to the pre-0002
 * shape (every project is Supabase, `external_id` comes from `ref`) so the dashboard still
 * renders. Writes narrow instead; see `forWrite` below.
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

export async function listAccounts(db?: SupabaseClient): Promise<Account[]> {
  if (usingNodeBackend()) return (await api.listAccounts()).accounts;

  const { data, error } = await (await client(db))
    .from("accounts")
    .select("*")
    .order("created_at");
  if (error) throw error;
  return (data as Record<string, unknown>[]).map(normalizeAccount);
}

export async function listProjects(db?: SupabaseClient): Promise<ProjectWithAccount[]> {
  if (usingNodeBackend()) return (await api.listProjects()).projects;

  const { data, error } = await (await client(db))
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

export async function getProject(
  id: string,
  db?: SupabaseClient,
): Promise<ProjectWithAccount | null> {
  if (usingNodeBackend()) {
    try {
      return (await api.getProject(id)).project;
    } catch (e) {
      // A 404 here means "not yours or not there", which the Supabase path expresses as a
      // null row rather than an error. Same answer, so the callers need no new branch.
      const { ApiError } = await import("@/lib/backend/client");
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  const { data, error } = await (await client(db))
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

export async function recentLogs(
  projectId: string,
  limit = 15,
  db?: SupabaseClient,
): Promise<PingLog[]> {
  if (usingNodeBackend()) return (await api.recentLogs(projectId, limit)).logs;

  const { data, error } = await (await client(db))
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

/**
 * Every project with keep-alive enabled. Service role on purpose: the nightly sweep has no
 * user session and must cover everybody.
 *
 * `userId` narrows it in SQL, used when a signed-in user presses "Ping all now" — so one
 * user's action never pulls another user's rows into this process at all.
 */
export async function keepAliveProjects(userId?: string): Promise<Project[]> {
  let query = supabaseService().from("projects").select("*").eq("keep_alive", true);
  if (userId) query = query.eq("user_id", userId);

  const { data, error } = await query;
  if (error) throw error;
  return (data as Record<string, unknown>[]).map(normalizeProject);
}

/**
 * Has migration 0002 been applied?
 *
 * Probes for one of the new columns with the service role, so the answer doesn't depend on
 * RLS or on there being any rows the current user can see. Cached per process — the answer
 * only changes when the user runs the SQL.
 */
let migrationApplied: boolean | null = null;

export async function schemaStatus(): Promise<{ migration0002: boolean }> {
  // There are no hand-run migrations on the Node backend — `ensureIndexes()` runs at boot,
  // before the first request — so the question it answers has no node equivalent. Reporting
  // "applied" keeps the dashboard's migration banner hidden, which is the honest outcome:
  // there is nothing for the user to go and run.
  if (usingNodeBackend()) return { migration0002: true };

  if (migrationApplied !== null) return { migration0002: migrationApplied };
  const { error } = await supabaseService()
    .from("projects")
    .select("provider,external_id,metadata")
    .limit(1);
  // 42703 = undefined_column. Any other error is a real problem and surfaces elsewhere.
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
 * secrets are deliberately excluded, so this file is safe to keep on disk. Runs as the user,
 * so you can only ever export your own rows.
 */
export async function exportRegistry() {
  if (usingNodeBackend()) return api.exportRegistry();

  const db = await supabaseServer();
  const [accounts, projects] = await Promise.all([listAccounts(db), listProjects(db)]);
  const { data: logs, error } = await db
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

/**
 * Columns migration 0006 dropped. Detected once per process, because a write that names a
 * missing column fails outright — and the direction of drift is the opposite of 0002's:
 * there the code was ahead of the schema, here the schema is ahead of any lingering code.
 */
const DROPPED_BY_0006 = ["ref", "ping_table", "anon_key"] as const;

let legacyColumnsPresent: boolean | null = null;

async function hasLegacyColumns(): Promise<boolean> {
  if (legacyColumnsPresent !== null) return legacyColumnsPresent;
  const { error } = await supabaseService().from("projects").select("ref").limit(1);
  legacyColumnsPresent = !(error && error.code === "42703");
  return legacyColumnsPresent;
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
 * Without this, the multi-provider code would break the one thing that already worked —
 * pinging — by inserting a `strategy` column that doesn't exist. Reads normalise, writes
 * narrow, and the dashboard banner tells the user how to get the full feature set.
 */
export async function forWrite<T extends Record<string, unknown>>(
  table: keyof typeof POST_0002_COLUMNS,
  row: T,
): Promise<Partial<T>> {
  const drop = new Set<string>();

  const { migration0002 } = await schemaStatus();
  if (!migration0002) for (const c of POST_0002_COLUMNS[table]) drop.add(c);

  if (table === "projects" && !(await hasLegacyColumns())) {
    for (const c of DROPPED_BY_0006) drop.add(c);
  }

  if (drop.size === 0) return row;
  return Object.fromEntries(Object.entries(row).filter(([k]) => !drop.has(k))) as Partial<T>;
}
