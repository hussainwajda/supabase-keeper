import { schedulerIntervalHours } from "../config/env";
import { pruneExpiredSessions } from "../vault/session";
import { pingProjects } from "./ping";
import { summarise } from "./summary";

/**
 * Run the sweep from inside this process.
 *
 * This is the capability the move off Vercel actually buys. There, the sweep had to be an
 * HTTP endpoint poked by Vercel Cron, which on the Hobby plan means **one run per day** and
 * a hard 60-second ceiling per invocation — two constraints that shaped
 * `pingProjects` more than anything else in it. A long-lived Node process has neither, so a
 * self-hoster can sweep four times a day by setting a number, and nothing external needs
 * configuring.
 *
 * `setInterval` rather than a cron library: the schedule is "every N hours", there is no cron
 * expression to parse, and the behaviour wanted on a missed tick (skip it, the next sweep
 * catches up — every project has its own `interval_days`) is exactly what an interval does.
 *
 * `unref()` matters. Without it the timer keeps the event loop alive and the process ignores
 * SIGTERM until the next tick, which in a container means being killed rather than shutting
 * down.
 */
let timer: NodeJS.Timeout | null = null;
let running = false;

export function startScheduler(): void {
  const hours = schedulerIntervalHours();
  const intervalMs = Math.max(1, hours) * 60 * 60 * 1000;

  console.log(`[keepstack:backend] in-process scheduler on, sweeping every ${hours}h`);

  // A sweep shortly after boot, not immediately: give the process a moment to be ready to
  // serve requests first, since the sweep can take tens of seconds.
  timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref();
  setTimeout(() => void runOnce(), 30_000).unref();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * One sweep, guarded against overlap.
 *
 * A sweep slower than the interval would otherwise start a second run while the first is
 * still going, and two concurrent sweeps would ping the same projects twice and race each
 * other's writes. Skipping is right rather than queueing: the work is idempotent and the next
 * tick will pick up whatever was missed.
 */
async function runOnce(): Promise<void> {
  if (running) {
    console.warn("[keepstack:backend] previous sweep still running, skipping this tick");
    return;
  }
  running = true;

  try {
    const started = Date.now();
    const results = await pingProjects();
    const pruned = await pruneExpiredSessions();
    const { payload, failures } = summarise(results);

    console.log(
      `[keepstack:backend] sweep done in ${Date.now() - started}ms`,
      JSON.stringify({ ...payload, pruned }),
    );
    if (failures.length) console.error("[keepstack:backend] sweep failures", failures);
  } catch (e) {
    // Never let a failed sweep take the process down — the next tick tries again.
    console.error("[keepstack:backend] sweep threw", e);
  } finally {
    running = false;
  }
}
