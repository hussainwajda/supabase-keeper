import "server-only";
import { supabaseService } from "@/lib/supabase/service";
import { forWrite, keepAliveProjects, type Project } from "@/lib/registry";
import { resolveServerCredentials } from "@/lib/vault/resolve";
import { vaultConfigured } from "@/lib/crypto/env";
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
      // Canonically in metadata; the dropped column is read only for registries pre-0006.
      ping_table: (p.metadata.ping_table as string | undefined) ?? p.ping_table ?? null,
    },
  };
}

/**
 * Credentials for one project, decrypted from the vault.
 *
 * Merges the account's credentials (a Supabase PAT) with the project's own (an anon key), so
 * an adapter can pick its best transport. Falls back to the legacy plaintext column for
 * registries that haven't run migration 0006 yet.
 */
async function credentialsFor(p: Project): Promise<Record<string, string | undefined>> {
  const resolved =
    vaultConfigured() && p.user_id
      ? await resolveServerCredentials(p.user_id, {
          accountId: p.account_id,
          projectId: p.id,
        })
      : {};

  // Pre-0006 registries still have the plaintext column; the vault wins where both exist.
  if (!resolved.anon_key && p.anon_key) resolved.anon_key = p.anon_key;
  return resolved;
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
    outcome = await adapter.ping(toProjectRef(p), await credentialsFor(p));
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
    supabaseService().from("projects").update(projectUpdate).eq("id", p.id),
    supabaseService().from("ping_logs").insert(logInsert),
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
 * Sweep every enabled project, routing by the provider's strategy:
 *
 *   ping        -> `pingProject` when due by `interval_days`
 *   watch       -> `captureUsage` daily; never a ping, because that would spend the quota
 *                  the watching is meant to protect
 *   alert_only  -> a status read, recorded as a check and never as a keep-alive
 *
 * Phase 8 adds bounded concurrency and per-provider deadlines so one provider's outage can't
 * eat the whole 60-second budget.
 */
export async function pingProjects({
  force = false,
  provider,
  userId,
}: { force?: boolean; provider?: string; userId?: string } = {}): Promise<PingResult[]> {
  // `userId` is set when a signed-in user presses "Ping all now", so one user can never
  // trigger pings across someone else's projects. The cron omits it and covers everybody.
  const all = await keepAliveProjects(userId);
  const candidates = all.filter((p) => !provider || p.provider === provider);

  const { captureUsage } = await import("@/lib/usage");
  const results: PingResult[] = [];

  for (const p of candidates) {
    const adapter = getProvider(p.provider);

    if (adapter.policy.strategy === "watch") {
      // Usage is cheap and the signal is a trend, so read it daily rather than on an
      // interval. `force` changes nothing here — there is no clock to reset.
      if (!force && !isDue({ ...p, interval_days: 1 })) continue;

      const watched = await captureUsage(p);
      results.push({
        projectId: watched.projectId,
        provider: watched.provider,
        name: watched.name,
        status: watched.status,
        strategy: "watch",
        httpStatus: null,
        durationMs: 0,
        error: watched.error,
        via: watched.status === "ok" ? `usage read (${watched.metrics} metrics)` : "usage read",
      });
      continue;
    }

    if (!force && !isDue(p)) continue;
    results.push(await pingProject(p));
  }

  // Housekeeping: keep 90 days of logs.
  await supabaseService()
    .from("ping_logs")
    .delete()
    .lt("created_at", new Date(Date.now() - 90 * DAY_MS).toISOString());
  return results;
}
