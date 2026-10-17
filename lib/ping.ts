import "server-only";
import { db, forWrite, keepAliveProjects, type Project } from "@/lib/registry";
import { getProvider } from "@/lib/providers/registry";
import type { PingOutcome, ProjectRef, Strategy } from "@/lib/providers/types";

const DAY_MS = 24 * 60 * 60 * 1000;
// Cron runs daily at a fixed time; allow slack so a project due "in 23h50m" isn't skipped a whole day.
const DUE_SLACK_MS = 2 * 60 * 60 * 1000;

export type PingResult = {
  projectId: string;
  provider: string;
  name: string;
  status: "ok" | "error";
  strategy: Strategy;
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
  via: string | null;
};

export function isDue(p: Project, now = Date.now()): boolean {
  if (!p.keep_alive) return false;
  if (!p.last_pinged_at) return true;
  return now - new Date(p.last_pinged_at).getTime() >= p.interval_days * DAY_MS - DUE_SLACK_MS;
}

/** The shape adapters expect, built from a registry row. */
export function toProjectRef(p: Project): ProjectRef {
  return {
    externalId: p.external_id,
    name: p.name,
    metadata: {
      ...p.metadata,
      // Legacy column still wins until migration 0006 drops it.
      ping_table: p.ping_table ?? (p.metadata.ping_table as string | undefined) ?? null,
    },
  };
}

/**
 * Credentials for one project.
 *
 * Phase 2 replaces this with a decrypting read from the `secrets` table. Until then the
 * Supabase anon key still lives in a plaintext column, which is exactly what migration 0005
 * is for.
 */
function credentialsFor(p: Project): Record<string, string | undefined> {
  return { anon_key: p.anon_key ?? undefined };
}

export async function pingProject(p: Project): Promise<PingResult> {
  const adapter = getProvider(p.provider);

  let outcome: PingOutcome;
  if (!adapter.ping) {
    // A `watch` or `alert_only` provider reached the ping path. Record it honestly rather
    // than reporting a keep-alive that never happened.
    outcome = {
      status: "error",
      strategy: adapter.policy.strategy,
      httpStatus: null,
      durationMs: 0,
      error: `${adapter.name} cannot be kept alive by pinging (${adapter.policy.strategy}).`,
    };
  } else {
    outcome = await adapter.ping(toProjectRef(p), credentialsFor(p));
  }

  const now = new Date().toISOString();
  const [projectUpdate, logInsert] = await Promise.all([
    forWrite("projects", {
      last_pinged_at: now,
      last_status: outcome.status,
      last_error: outcome.error,
      ...(outcome.lifecycle ? { lifecycle: outcome.lifecycle } : {}),
    }),
    forWrite("ping_logs", {
      project_id: p.id,
      status: outcome.status,
      strategy: outcome.strategy,
      via: outcome.via ?? null,
      http_status: outcome.httpStatus,
      duration_ms: outcome.durationMs,
      error: outcome.error,
    }),
  ]);

  await Promise.all([
    db().from("projects").update(projectUpdate).eq("id", p.id),
    db().from("ping_logs").insert(logInsert),
  ]);

  return {
    projectId: p.id,
    provider: p.provider,
    name: p.name,
    status: outcome.status,
    strategy: outcome.strategy,
    httpStatus: outcome.httpStatus,
    durationMs: outcome.durationMs,
    error: outcome.error,
    via: outcome.via ?? null,
  };
}

/**
 * Ping every keep-alive project (only due ones unless `force`). Used by the cron and "Ping all".
 *
 * Phase 8 adds bounded concurrency and per-provider deadlines so one provider's outage can't
 * eat the whole 60-second budget. With a single provider the current shape is fine.
 */
export async function pingProjects({
  force = false,
  provider,
}: { force?: boolean; provider?: string } = {}): Promise<PingResult[]> {
  const all = await keepAliveProjects();
  const targets = all
    .filter((p) => !provider || p.provider === provider)
    .filter((p) => force || isDue(p));

  const results = await Promise.all(targets.map(pingProject));

  // Housekeeping: keep 90 days of logs.
  await db()
    .from("ping_logs")
    .delete()
    .lt("created_at", new Date(Date.now() - 90 * DAY_MS).toISOString());
  return results;
}
