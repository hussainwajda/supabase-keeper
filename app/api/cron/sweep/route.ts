import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/auth";
import { pingProjects } from "@/lib/ping";
import { pruneExpiredSessions } from "@/lib/vault/session";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/types";
import { usingNodeBackend } from "@/lib/backend/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The nightly sweep. Vercel Cron calls this daily (see vercel.json) with
 * `Authorization: Bearer $CRON_SECRET`.
 *
 * Each project is only pinged when it's due according to its own `interval_days`.
 *   ?force=1            ping every keep-alive project regardless of schedule
 *   ?provider=supabase  limit the run to one provider, for debugging
 */
export async function GET(req: NextRequest) {
  /*
   * This route sweeps the *Supabase* registry. On the Node backend the sweep belongs to that
   * service — it owns the data, and it can run the sweep on a timer in its own process rather
   * than needing to be poked over HTTP at all (`ENABLE_SCHEDULER=true`).
   *
   * Answering with an explanation rather than running is the point: `pingProjects()` here
   * would reach for the Supabase service role and fail with something about a missing
   * environment variable, which tells whoever wired the cron up nothing useful. Worse, a
   * schedule left pointing at this URL would look like it was working.
   */
  if (usingNodeBackend()) {
    return NextResponse.json(
      {
        error:
          "This deployment runs on the Node backend, which sweeps its own registry. Point your scheduler at the backend's /api/cron/sweep, or set ENABLE_SCHEDULER=true there and drop the external cron entirely.",
        code: "wrong_backend",
      },
      { status: 501 },
    );
  }

  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const providerParam = req.nextUrl.searchParams.get("provider");
  const provider = PROVIDER_IDS.includes(providerParam as ProviderId)
    ? (providerParam as ProviderId)
    : undefined;

  const results = await pingProjects({
    force: req.nextUrl.searchParams.get("force") === "1",
    provider,
  });

  // Housekeeping: expired sudo sessions and spent OTP challenges don't linger.
  await pruneExpiredSessions();

  const failed = results.filter((r) => r.status === "error");
  if (failed.length) console.error("keepstack sweep failures", failed);

  // Per-provider rollup, so a single provider's outage is visible at a glance in the logs.
  const byProvider: Record<string, { ok: number; failed: number; strategy: string }> = {};
  for (const r of results) {
    byProvider[r.provider] ??= { ok: 0, failed: 0, strategy: r.strategy };
    byProvider[r.provider][r.status === "ok" ? "ok" : "failed"]++;
  }

  // Counted separately because they are different claims: a ping reset an inactivity clock,
  // a usage read did not and never pretends to have.
  const pinged = results.filter((r) => r.strategy === "ping").length;
  const watched = results.filter((r) => r.strategy === "watch").length;
  const checked = results.filter((r) => r.strategy === "alert_only").length;

  return NextResponse.json({
    processed: results.length,
    pinged,
    watched,
    checked,
    ok: results.length - failed.length,
    failed: failed.length,
    byProvider,
    results,
  });
}
