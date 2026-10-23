import "server-only";
import { supabaseService } from "@/lib/supabase/service";
import { getProvider } from "@/lib/providers/registry";
import { resolveServerCredentials } from "@/lib/vault/resolve";
import { vaultConfigured } from "@/lib/crypto/env";
import { toProjectRef } from "@/lib/ping";
import type { Project } from "@/lib/registry";
import type { UsageSnapshot } from "@/lib/providers/types";
import { usingNodeBackend } from "@/lib/backend/env";
import * as api from "@/lib/backend/api";


/**
 * The UTC calendar day of an instant.
 *
 * Must agree with the `captured_on` column default in migration 0007,
 * `(now() AT TIME ZONE 'UTC')::date`, because that column is the upsert's conflict target —
 * and the uniqueness guarantee is only "one reading per day" if both sides agree on which
 * day it is. `toISOString()` is always UTC, so this is independent of the server's timezone.
 */
export function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export type UsageRow = {
  /**
   * `number` under Supabase (a Postgres `bigint`), `string` under the Node backend (a UUID —
   * see backend-node/src/db/ids.ts). Widened rather than cast at the boundary because it is
   * only ever a React key; nothing does arithmetic on it.
   */
  id: number | string;
  project_id: string;
  metric: string;
  value: number;
  limit_value: number | null;
  unit: string;
  period_start: string | null;
  period_end: string | null;
  captured_at: string;
  /** The UTC day, written alongside `captured_at`; the upsert's conflict target. */
  captured_on?: string;
};

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
 * stacking rows — the daily sweep and a manual refresh then behave the same way.
 */
export async function captureUsage(p: Project): Promise<WatchResult> {
  const adapter = getProvider(p.provider);
  const base = { projectId: p.id, name: p.name, provider: p.provider };

  if (!adapter.usage) {
    return { ...base, status: "error", metrics: 0, error: `${adapter.name} reports no usage.` };
  }

  const credentials =
    vaultConfigured() && p.user_id
      ? await resolveServerCredentials(p.user_id, { accountId: p.account_id, projectId: p.id })
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
    snapshots = await adapter.usage(toProjectRef(p), credentials);
  } catch (e) {
    const error = (e as Error).message;
    if (readIsTheKeepAlive) {
      await supabaseService()
        .from("projects")
        .update({
          last_pinged_at: new Date().toISOString(),
          last_status: "error",
          last_error: error,
        })
        .eq("id", p.id);
    }
    return { ...base, status: "error", metrics: 0, error };
  }

  const db = supabaseService();
  const capturedAt = new Date().toISOString();
  // Derived from the same instant, so the two columns can never disagree.
  const capturedOn = utcDay(capturedAt);

  for (const s of snapshots) {
    // One row per metric per day: the nightly sweep and a manual refresh both replace
    // today's reading rather than stacking rows. `captured_on` is sent explicitly because
    // it is what the unique index — and therefore the conflict target — is on.
    const { error } = await db.from("usage_snapshots").upsert(
      {
        project_id: p.id,
        metric: s.metric,
        value: s.value,
        limit_value: s.limitValue,
        unit: s.unit,
        period_start: s.periodStart,
        period_end: s.periodEnd,
        captured_at: capturedAt,
        captured_on: capturedOn,
      },
      { onConflict: "project_id,metric,captured_on", ignoreDuplicates: false },
    );
    if (error) {
      // Don't let one metric's write failure look like a successful capture.
      return { ...base, status: "error", metrics: 0, error: error.message };
    }
  }

  if (readIsTheKeepAlive) {
    await db
      .from("projects")
      .update({
        last_pinged_at: capturedAt,
        last_status: "ok",
        last_error: null,
        lifecycle: "active",
      })
      .eq("id", p.id);
  }

  return { ...base, status: "ok", metrics: snapshots.length, error: null };
}

/**
 * Which of these projects already have a reading for the given UTC day.
 *
 * One query for the whole sweep, and the answer comes from the snapshots themselves rather
 * than from a column on `projects` — so a `ping` provider's daily usage read has its own
 * cadence without borrowing the ping clock, which it would otherwise reset. See `captureUsage`.
 */
export async function projectsWithUsageOn(
  projectIds: string[],
  day: string,
): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();

  const { data, error } = await supabaseService()
    .from("usage_snapshots")
    .select("project_id")
    .in("project_id", projectIds)
    .eq("captured_on", day);

  // A missing `captured_on` column means migration 0007 hasn't been run. Returning an empty
  // set makes every project look due, which is the safe direction: a usage read is cheap and
  // the upsert will surface the real problem.
  if (error) return new Set();
  return new Set((data ?? []).map((r) => (r as { project_id: string }).project_id));
}

/** Latest reading per metric for one project. */
export async function latestUsage(projectId: string): Promise<UsageRow[]> {
  if (usingNodeBackend()) return (await api.latestUsage(projectId)).usage;

  const { data, error } = await supabaseService()
    .from("usage_snapshots")
    .select("*")
    .eq("project_id", projectId)
    .order("captured_at", { ascending: false })
    .limit(60);
  if (error) return [];

  const seen = new Set<string>();
  const latest: UsageRow[] = [];
  for (const row of (data ?? []) as UsageRow[]) {
    if (seen.has(row.metric)) continue;
    seen.add(row.metric);
    latest.push(row);
  }
  return latest;
}

/** History for one metric, oldest first, for a sparkline. */
export async function usageHistory(
  projectId: string,
  metric: string,
  days = 30,
): Promise<UsageRow[]> {
  if (usingNodeBackend()) return (await api.usageHistory(projectId, metric, days)).history;

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabaseService()
    .from("usage_snapshots")
    .select("*")
    .eq("project_id", projectId)
    .eq("metric", metric)
    .gte("captured_at", since)
    .order("captured_at");
  if (error) return [];
  return (data ?? []) as UsageRow[];
}

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
