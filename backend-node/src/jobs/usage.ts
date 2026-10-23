import { projects, usageSnapshots } from "../db/collections";
import type { ProjectDoc } from "../db/documents";
import { newId } from "../db/ids";
import { owned, scopeFor, type Scope } from "../db/scope";
import { vaultConfigured } from "../crypto/env";
import { toUsageRow } from "../http/serialize";
import { getProvider } from "../providers/registry";
import type { UsageSnapshot } from "../providers/types";
import { resolveServerCredentials } from "../vault/resolve";
import { toProjectRef } from "./ping";

/**
 * The UTC calendar day of an instant.
 *
 * In Postgres this had to agree with a column default — `(now() AT TIME ZONE 'UTC')::date` —
 * because that column was the upsert's conflict target, and the "one reading per day"
 * guarantee only held if both sides agreed on which day it was. Here the application is the
 * only writer and computes the value itself, so there is no second definition to keep in
 * step. `toISOString()` is always UTC, so this is independent of the server's timezone.
 */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type WatchResult = {
  projectId: string;
  name: string;
  provider: string;
  status: "ok" | "error";
  metrics: number;
  error: string | null;
};

/**
 * Read a `watch` provider's usage and record it.
 *
 * Upserts on (project, metric, day) so a re-run replaces the day's reading rather than
 * stacking documents — the daily sweep and a manual refresh then behave the same way.
 */
export async function captureUsage(project: ProjectDoc): Promise<WatchResult> {
  const adapter = getProvider(project.provider);
  const base = { projectId: project._id, name: project.name, provider: project.provider };

  if (!adapter.usage) {
    return { ...base, status: "error", metrics: 0, error: `${adapter.name} reports no usage.` };
  }

  const scope = scopeFor(project.user_id);
  const credentials = vaultConfigured()
    ? await resolveServerCredentials(scope, {
        accountId: project.account_id,
        projectId: project._id,
      })
    : {};

  /*
   * Whether a usage read is this project's keep-alive, or merely extra information.
   *
   * For a `watch` provider (Neon) the daily read *is* the whole activity — so it sets the
   * project's last-checked time and status. For a `ping` provider that also reports quotas
   * (Upstash) it must not: writing `last_pinged_at` here would make the project look pinged
   * every single day, `isDue` would never fire again, and the keep-alive would silently stop
   * while the dashboard showed green. The same reason a failed stats read must not mark a
   * project as failing — the ping is what decides that.
   */
  const readIsTheKeepAlive = adapter.policy.strategy === "watch";

  let snapshots: UsageSnapshot[];
  try {
    snapshots = await adapter.usage(toProjectRef(project), credentials);
  } catch (e) {
    const error = (e as Error).message;
    if (readIsTheKeepAlive) {
      await projects().updateOne(
        { _id: project._id },
        { $set: { last_pinged_at: new Date(), last_status: "error", last_error: error } },
      );
    }
    return { ...base, status: "error", metrics: 0, error };
  }

  const capturedAt = new Date();
  // Derived from the same instant, so the two fields can never disagree.
  const capturedOn = utcDay(capturedAt);

  for (const s of snapshots) {
    try {
      await usageSnapshots().updateOne(
        { project_id: project._id, metric: s.metric, captured_on: capturedOn },
        {
          $set: {
            value: s.value,
            limit_value: s.limitValue,
            unit: s.unit,
            period_start: s.periodStart ? new Date(s.periodStart) : null,
            period_end: s.periodEnd ? new Date(s.periodEnd) : null,
            captured_at: capturedAt,
          },
          $setOnInsert: {
            _id: newId(),
            project_id: project._id,
            user_id: project.user_id,
            metric: s.metric,
            captured_on: capturedOn,
          },
        },
        { upsert: true },
      );
    } catch (e) {
      // Don't let one metric's write failure look like a successful capture.
      return { ...base, status: "error", metrics: 0, error: (e as Error).message };
    }
  }

  if (readIsTheKeepAlive) {
    await projects().updateOne(
      { _id: project._id },
      {
        $set: {
          last_pinged_at: capturedAt,
          last_status: "ok",
          last_error: null,
          lifecycle: "active",
        },
      },
    );
  }

  return { ...base, status: "ok", metrics: snapshots.length, error: null };
}

/**
 * Which of these projects already have a reading for the given UTC day.
 *
 * One query for the whole sweep, and the answer comes from the snapshots themselves rather
 * than from a field on the project — so a `ping` provider's daily usage read has its own
 * cadence without borrowing the ping clock, which it would otherwise reset. See `captureUsage`.
 */
export async function projectsWithUsageOn(projectIds: string[], day: string): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();

  const docs = await usageSnapshots()
    .find({ project_id: { $in: projectIds }, captured_on: day })
    .project<{ project_id: string }>({ project_id: 1 })
    .toArray();
  return new Set(docs.map((d) => d.project_id));
}

/** Latest reading per metric for one project. */
export async function latestUsage(scope: Scope, projectId: string) {
  const docs = await usageSnapshots()
    .find({ ...owned(scope), project_id: projectId })
    .sort({ captured_at: -1 })
    .limit(60)
    .toArray();

  const seen = new Set<string>();
  const latest = [];
  for (const doc of docs) {
    if (seen.has(doc.metric)) continue;
    seen.add(doc.metric);
    latest.push(toUsageRow(doc));
  }
  return latest;
}

/** History for one metric, oldest first, for a sparkline. */
export async function usageHistory(
  scope: Scope,
  projectId: string,
  metric: string,
  days = 30,
) {
  const since = new Date(Date.now() - days * 86_400_000);
  const docs = await usageSnapshots()
    .find({ ...owned(scope), project_id: projectId, metric, captured_at: { $gte: since } })
    .sort({ captured_at: 1 })
    .toArray();
  return docs.map(toUsageRow);
}

export type UsageRow = ReturnType<typeof toUsageRow>;

/**
 * Days of headroom at the current burn rate.
 *
 * Deliberately simple: spend so far ÷ elapsed days in the period, projected against what is
 * left. A 7-day moving average would be better once there's history, but a rough number today
 * is worth more than a precise one next month — and this is a warning, not a billing forecast.
 *
 * Returns null when there's no limit, nothing has been used, or the metric isn't periodic.
 */
export function daysOfHeadroom(row: UsageRow): number | null {
  if (row.limit_value === null || row.limit_value <= 0) return null;
  if (!row.period_start) return null;
  if (row.value <= 0) return null;

  const elapsedDays = Math.max(
    0.5,
    (Date.now() - new Date(row.period_start).getTime()) / 86_400_000,
  );
  const perDay = row.value / elapsedDays;
  if (perDay <= 0) return null;

  const remaining = row.limit_value - row.value;
  if (remaining <= 0) return 0;
  return remaining / perDay;
}

/** How much of the allowance is used, 0-1+, or null when there's no limit. */
export function usageFraction(row: UsageRow): number | null {
  if (row.limit_value === null || row.limit_value <= 0) return null;
  return row.value / row.limit_value;
}
