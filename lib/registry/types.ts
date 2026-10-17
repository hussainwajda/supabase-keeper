import type { Lifecycle, ProviderId, Strategy } from "@/lib/providers/types";

export type Account = {
  id: string;
  provider: ProviderId;
  email: string;
  label: string | null;
  login_method: string | null;
  notes: string | null;
  last_synced_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  created_at: string;
};

export type Project = {
  id: string;
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
  last_pinged_at: string | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  discovered_at: string | null;
  created_at: string;

  /**
   * Legacy Supabase-only columns, kept until migration 0006 drops them.
   * New code reads `external_id` and `metadata.ping_table` instead.
   */
  ref: string | null;
  ping_table: string | null;
  /** Plaintext until Phase 2 moves it into the encrypted `secrets` table. */
  anon_key: string | null;
};

/** A project with its secret columns stripped — the only shape a client component may receive. */
export type SafeProject = Omit<Project, "anon_key"> & { has_key: boolean };

export type ProjectWithAccount = Project & { account: Account | null };
export type SafeProjectWithAccount = SafeProject & { account: Account | null };

export type PingLog = {
  id: number;
  project_id: string;
  status: string;
  strategy: Strategy;
  via: string | null;
  http_status: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
};

/**
 * Strip every secret column before a project crosses into a client component.
 * Secrets never reach the browser — see docs/SECURITY.md §6.
 */
export function toSafeProject<T extends Project>(
  project: T,
): Omit<T, "anon_key"> & { has_key: boolean } {
  const { anon_key, ...rest } = project;
  return { ...rest, has_key: !!anon_key };
}
