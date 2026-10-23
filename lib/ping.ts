import "server-only";
import { supabaseService } from "@/lib/supabase/service";
import { forWrite, keepAliveProjects, type Project } from "@/lib/registry";
import { resolveServerCredentials } from "@/lib/vault/resolve";
import { vaultConfigured } from "@/lib/crypto/env";
import { mapWithDeadline } from "@/lib/concurrency";
import { getProvider } from "@/lib/providers/registry";
import type { Lifecycle, PingOutcome, ProjectRef, Strategy } from "@/lib/providers/types";

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
 * The `alert_only` check: read the provider's status and record it as a check.
 *
 * Appwrite is the case this exists for. Its pause is driven by *Console* activity, which no
 * API call of ours can imitate, so there is nothing to ping — but detecting the pause early
 * is the entire value, because 90 days later the data is deleted.
 *
 * Recorded as `strategy: "alert_only"`, never as a successful keep-alive. `last_pinged_at` is
 * updated because it means "last checked" in the UI, and the one place that would read it as
 * "the clock was reset" — the pause-risk countdown — is gated on `ping` providers.
 */
export async function checkStatus(p: Project): Promise<PingResult> {
  const adapter = getProvider(p.provider);
  const started = Date.now();
  const base = {
    projectId: p.id,
    provider: p.provider,
    name: p.name,
    strategy: "alert_only" as const,
    httpStatus: null,
    via: "status check",
  };

  if (!adapter.status) {
    return {
      ...base,
      status: "error",
      durationMs: 0,
      error: `${adapter.name} reports no status Keepstack can read.`,
    };
  }

  let lifecycle: Lifecycle | null = null;
  let raw: string | null = null;
  let error: string | null = null;
  try {
    const result = await adapter.status(toProjectRef(p), await credentialsFor(p));
    lifecycle = result.lifecycle;
    raw = result.raw;
  } catch (e) {
    error = (e as Error).message;
  }

  // A paused project is a failed check: that is exactly the state worth alerting on, and the
  // sweep's failure list is what the cron logs and Phase 8's alerts read.
  const paused = lifecycle === "paused" || lifecycle === "archived";
  if (paused) {
    error = `${p.name} is ${adapter.policy.pauseNoun} at ${adapter.name}. ${
      adapter.policy.deletesAfterDays !== null
        ? `It will be deleted with all its data ${adapter.policy.deletesAfterDays} days after it was ${adapter.policy.pauseNoun}. `
        : ""
    }Opening it in the console is what resumes it.`;
  }

  const now = new Date().toISOString();
  const [projectUpdate, logInsert] = await Promise.all([
    forWrite("projects", {
      last_pinged_at: now,
      last_status: error ? "error" : "ok",
      last_error: error,
      ...(lifecycle ? { lifecycle, provider_status: raw } : {}),
    }),
    forWrite("ping_logs", {
      project_id: p.id,
      status: error ? "error" : "ok",
      strategy: "alert_only",
      via: raw ? `status check (${raw})` : "status check",
      http_status: null,
      duration_ms: Date.now() - started,
      error,
    }),
  ]);

  await Promise.all([
    supabaseService().from("projects").update(projectUpdate).eq("id", p.id),
    supabaseService().from("ping_logs").insert(logInsert),
  ]);

  return {
    ...base,
    status: error ? "error" : "ok",
    durationMs: Date.now() - started,
    error,
    via: raw ? `status check (${raw})` : "status check",
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
 * Bounded concurrency with per-provider deadlines keeps one provider's outage from eating the
 * whole 60-second budget.
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

  const { captureUsage, projectsWithUsageOn, utcDay } = await import("@/lib/usage");

  /*
   * Which projects already have today's usage reading.
   *
   * Asked once for the whole sweep, and read from the snapshots rather than from a column on
   * `projects`, because a usage read must not share the ping clock — see `captureUsage`.
   */
  const today = utcDay(new Date().toISOString());
  const wantsUsage = candidates.filter((p) => {
    const a = getProvider(p.provider);
    return a.capabilities.watch && !!a.usage;
  });
  const usageDoneToday = await projectsWithUsageOn(
    wantsUsage.map((p) => p.id),
    today,
  );

  /** Read one project's usage, as a sweep result. */
  async function readUsage(p: Project): Promise<PingResult> {
    const watched = await captureUsage(p);
    return {
      projectId: watched.projectId,
      provider: watched.provider,
      name: watched.name,
      status: watched.status,
      strategy: "watch",
      httpStatus: null,
      durationMs: 0,
      error: watched.error,
      via: watched.status === "ok" ? `usage read (${watched.metrics} metrics)` : "usage read",
    };
  }

  /**
   * One project, routed by its provider's strategy. Returns every action taken, because a
   * provider can be both pingable and watchable: Upstash has an inactivity clock *and* a
   * monthly command budget, so a sweep may ping it and read its quota in the same run — two
   * separate claims, logged separately.
   */
  async function sweepOne(p: Project): Promise<PingResult[]> {
    const adapter = getProvider(p.provider);
    const results: PingResult[] = [];

    const usageDue =
      adapter.capabilities.watch && !!adapter.usage && (force || !usageDoneToday.has(p.id));

    if (adapter.policy.strategy === "watch") {
      // Usage is cheap and the signal is a trend, so read it daily rather than on an
      // interval. `force` changes nothing else here — there is no clock to reset.
      if (usageDue) results.push(await readUsage(p));
      return results;
    }

    if (adapter.policy.strategy === "alert_only") {
      // A daily check, so a pause is caught the day after it happens rather than whenever
      // someone next opens the dashboard.
      if (force || isDue({ ...p, interval_days: 1 })) results.push(await checkStatus(p));
      return results;
    }

    if (force || isDue(p)) results.push(await pingProject(p));
    // After the ping, so a provider that reports commands-per-month includes the one the
    // ping just spent.
    if (usageDue) results.push(await readUsage(p));
    return results;
  }

  // Grouped by provider, each group with its own deadline, so one provider's outage can't eat
  // the whole 60-second budget. Atlas is the reason this exists: a driver connection to a
  // paused cluster sits for its full 8-second timeout, and enough of them in a row would
  // exhaust the cron on their own.
  const groups = new Map<string, Project[]>();
  for (const p of candidates) {
    const list = groups.get(p.provider) ?? [];
    list.push(p);
    groups.set(p.provider, list);
  }

  const results: PingResult[] = [];
  const skipped: PingResult[] = [];
  const budgetPerProvider = Math.max(8_000, Math.floor(45_000 / Math.max(1, groups.size)));

  for (const [providerId, projects] of groups) {
    const adapter = getProvider(providerId as Project["provider"]);
    // Atlas opens real sockets, so keep it narrow; HTTP providers tolerate more.
    const limit = adapter.policy.strategy === "ping" && providerId === "mongodb" ? 2 : 6;

    const { results: done, skipped: notRun } = await mapWithDeadline(
      projects,
      limit,
      budgetPerProvider,
      sweepOne,
    );

    for (const r of done) if (r) results.push(...r);

    // Reported, not silently dropped: a project the sweep ran out of time for still gets
    // picked up on the next run, and the log says so.
    for (const p of notRun) {
      skipped.push({
        projectId: p.id,
        provider: p.provider,
        name: p.name,
        status: "error",
        strategy: getProvider(p.provider).policy.strategy,
        httpStatus: null,
        durationMs: 0,
        error: `Skipped: the ${providerId} budget for this run was used up. It will be retried on the next sweep.`,
        via: "skipped",
      });
    }
  }

  results.push(...skipped);

  // Housekeeping: keep 90 days of logs.
  await supabaseService()
    .from("ping_logs")
    .delete()
    .lt("created_at", new Date(Date.now() - 90 * DAY_MS).toISOString());
  return results;
}
