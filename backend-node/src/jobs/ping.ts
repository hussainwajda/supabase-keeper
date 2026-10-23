import { pingLogs, projects } from "../db/collections";
import type { ProjectDoc } from "../db/documents";
import { newId } from "../db/ids";
import { scopeFor } from "../db/scope";
import { vaultConfigured } from "../crypto/env";
import { mapWithDeadline } from "../lib/concurrency";
import { getProvider } from "../providers/registry";
import type { Credentials, Lifecycle, PingOutcome, ProjectRef, Strategy } from "../providers/types";
import { resolveServerCredentials } from "../vault/resolve";
import { keepAliveProjects } from "../registry/projects";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The sweep runs at a fixed time; allow slack so a project due "in 23h50m" isn't skipped a whole day. */
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

export function isDue(p: Pick<ProjectDoc, "keep_alive" | "last_pinged_at" | "interval_days">, now = Date.now()): boolean {
  if (!p.keep_alive) return false;
  if (!p.last_pinged_at) return true;
  return now - p.last_pinged_at.getTime() >= p.interval_days * DAY_MS - DUE_SLACK_MS;
}

/**
 * The shape adapters expect, built from a registry document.
 *
 * Simpler than its Supabase counterpart by one line, and the missing line is the point:
 * there, `ping_table` had to be read from `metadata` *or* from a legacy column that migration
 * 0006 dropped, because the code had to work on registries where the SQL hadn't been run yet.
 * Nothing here has a pre-migration shape to be compatible with.
 */
export function toProjectRef(p: ProjectDoc): ProjectRef {
  return {
    externalId: p.external_id,
    name: p.name,
    metadata: { ...p.metadata, ping_table: (p.metadata.ping_table as string | undefined) ?? null },
  };
}

/**
 * Credentials for one project, decrypted from the vault.
 *
 * Merges the account's credentials (a Supabase PAT) with the project's own (an anon key), so
 * an adapter can pick its best transport.
 */
async function credentialsFor(p: ProjectDoc): Promise<Credentials> {
  if (!vaultConfigured()) return {};
  return resolveServerCredentials(scopeFor(p.user_id), {
    accountId: p.account_id,
    projectId: p._id,
  });
}

/** Record the outcome of an attempt against the project and its log. */
async function recordOutcome(
  p: ProjectDoc,
  patch: Partial<ProjectDoc>,
  log: {
    status: string;
    strategy: Strategy;
    via: string | null;
    httpStatus: number | null;
    durationMs: number | null;
    error: string | null;
  },
): Promise<void> {
  await Promise.all([
    projects().updateOne({ _id: p._id }, { $set: patch }),
    pingLogs().insertOne({
      _id: newId(),
      project_id: p._id,
      // Denormalised so the log can be read back under the owner's scope without a join —
      // there is no RLS policy to do the join for us. See src/db/documents.ts, rule 3.
      user_id: p.user_id,
      status: log.status,
      strategy: log.strategy,
      via: log.via,
      http_status: log.httpStatus,
      duration_ms: log.durationMs,
      error: log.error,
      created_at: new Date(),
    }),
  ]);
}

export async function pingProject(p: ProjectDoc): Promise<PingResult> {
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

  await recordOutcome(
    p,
    {
      last_pinged_at: new Date(),
      last_status: outcome.status,
      last_error: outcome.error,
      ...(outcome.lifecycle ? { lifecycle: outcome.lifecycle } : {}),
    },
    {
      status: outcome.status,
      strategy: outcome.strategy,
      via: outcome.via ?? null,
      httpStatus: outcome.httpStatus,
      durationMs: outcome.durationMs,
      error: outcome.error,
    },
  );

  return {
    projectId: p._id,
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
export async function checkStatus(p: ProjectDoc): Promise<PingResult> {
  const adapter = getProvider(p.provider);
  const started = Date.now();
  const base = {
    projectId: p._id,
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
  // sweep's failure list is what the logs and any alert rules read.
  const paused = lifecycle === "paused" || lifecycle === "archived";
  if (paused) {
    error = `${p.name} is ${adapter.policy.pauseNoun} at ${adapter.name}. ${
      adapter.policy.deletesAfterDays !== null
        ? `It will be deleted with all its data ${adapter.policy.deletesAfterDays} days after it was ${adapter.policy.pauseNoun}. `
        : ""
    }Opening it in the console is what resumes it.`;
  }

  await recordOutcome(
    p,
    {
      last_pinged_at: new Date(),
      last_status: error ? "error" : "ok",
      last_error: error,
      ...(lifecycle ? { lifecycle, provider_status: raw } : {}),
    },
    {
      status: error ? "error" : "ok",
      strategy: "alert_only",
      via: raw ? `status check (${raw})` : "status check",
      httpStatus: null,
      durationMs: Date.now() - started,
      error,
    },
  );

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
 * whole budget.
 *
 * The budget itself is the one number worth revisiting in this port. On Vercel the ceiling is
 * a hard platform limit — 60 seconds per invocation, after which the function is killed
 * mid-sweep — and the 45-second figure below is that limit minus room to write results. A
 * long-lived Node process has no such ceiling, so this is now a self-imposed bound rather
 * than a survival tactic. It stays because the reason behind it hasn't changed: a sweep that
 * runs for twenty minutes because one provider is timing out is a sweep nobody can reason
 * about, and skipped projects are retried on the next run anyway.
 */
export async function pingProjects({
  force = false,
  provider,
  userId,
}: { force?: boolean; provider?: string; userId?: string } = {}): Promise<PingResult[]> {
  // `userId` is set when a signed-in user presses "Ping all now", so one user can never
  // trigger pings across someone else's projects. The sweep omits it and covers everybody.
  const all = await keepAliveProjects(userId);
  const candidates = all.filter((p) => !provider || p.provider === provider);

  // Imported dynamically to break a genuine cycle: usage.ts needs `toProjectRef` from here.
  const { captureUsage, projectsWithUsageOn, utcDay } = await import("./usage");

  /*
   * Which projects already have today's usage reading.
   *
   * Asked once for the whole sweep, and read from the snapshots rather than from a field on
   * the project, because a usage read must not share the ping clock — see `captureUsage`.
   */
  const today = utcDay(new Date());
  const wantsUsage = candidates.filter((p) => {
    const a = getProvider(p.provider);
    return a.capabilities.watch && !!a.usage;
  });
  const usageDoneToday = await projectsWithUsageOn(wantsUsage.map((p) => p._id), today);

  /** Read one project's usage, as a sweep result. */
  async function readUsage(p: ProjectDoc): Promise<PingResult> {
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
  async function sweepOne(p: ProjectDoc): Promise<PingResult[]> {
    const adapter = getProvider(p.provider);
    const results: PingResult[] = [];

    const usageDue =
      adapter.capabilities.watch && !!adapter.usage && (force || !usageDoneToday.has(p._id));

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
  // the whole budget. Atlas is the reason this exists: a driver connection to a paused
  // cluster sits for its full 8-second timeout, and enough of them in a row would exhaust the
  // run on their own.
  const groups = new Map<string, ProjectDoc[]>();
  for (const p of candidates) {
    const list = groups.get(p.provider) ?? [];
    list.push(p);
    groups.set(p.provider, list);
  }

  const results: PingResult[] = [];
  const skipped: PingResult[] = [];
  const budgetPerProvider = Math.max(8_000, Math.floor(45_000 / Math.max(1, groups.size)));

  for (const [providerId, group] of groups) {
    const adapter = getProvider(providerId as ProjectDoc["provider"]);
    // Atlas opens real sockets, so keep it narrow; HTTP providers tolerate more.
    const limit = adapter.policy.strategy === "ping" && providerId === "mongodb" ? 2 : 6;

    const { results: done, skipped: notRun } = await mapWithDeadline(
      group,
      limit,
      budgetPerProvider,
      sweepOne,
    );

    for (const r of done) if (r) results.push(...r);

    // Reported, not silently dropped: a project the sweep ran out of time for still gets
    // picked up on the next run, and the log says so.
    for (const p of notRun) {
      skipped.push({
        projectId: p._id,
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

  /*
   * No log pruning here.
   *
   * The Supabase sweep ended with a `delete from ping_logs where created_at < now() - 90 days`,
   * because nothing else was going to do it. `ping_logs` carries a TTL index instead
   * (src/db/indexes.ts), so MongoDB expires old entries on its own and the sweep spends its
   * whole budget on the work it was called for.
   */
  return results;
}
