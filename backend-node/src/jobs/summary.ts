import type { PingResult } from "./ping";

/**
 * Roll a sweep's results up for the log line and the response.
 *
 * The three counters are kept separate because they are three different claims, and
 * collapsing them into "47 projects processed" would be the dishonest version: a ping reset
 * an inactivity clock, a usage read did not and never pretends to have, and a status check
 * only observed. docs/ARCHITECTURE.md §1 calls this out as rule one — "`ping` never lies".
 */
export function summarise(results: PingResult[]) {
  const failures = results.filter((r) => r.status === "error");

  // Per-provider, so a single provider's outage is visible at a glance rather than buried in
  // a flat failure count.
  const byProvider: Record<string, { ok: number; failed: number; strategy: string }> = {};
  for (const r of results) {
    byProvider[r.provider] ??= { ok: 0, failed: 0, strategy: r.strategy };
    byProvider[r.provider][r.status === "ok" ? "ok" : "failed"]++;
  }

  return {
    failures,
    payload: {
      processed: results.length,
      pinged: results.filter((r) => r.strategy === "ping").length,
      watched: results.filter((r) => r.strategy === "watch").length,
      checked: results.filter((r) => r.strategy === "alert_only").length,
      ok: results.length - failures.length,
      failed: failures.length,
      byProvider,
    },
  };
}
