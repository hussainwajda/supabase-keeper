import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/auth";
import { pingProjects } from "@/lib/ping";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/types";

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

  const failed = results.filter((r) => r.status === "error");
  if (failed.length) console.error("keepstack sweep failures", failed);

  // Per-provider rollup, so a single provider's outage is visible at a glance in the logs.
  const byProvider: Record<string, { ok: number; failed: number }> = {};
  for (const r of results) {
    byProvider[r.provider] ??= { ok: 0, failed: 0 };
    byProvider[r.provider][r.status === "ok" ? "ok" : "failed"]++;
  }

  return NextResponse.json({
    pinged: results.length,
    ok: results.length - failed.length,
    failed: failed.length,
    byProvider,
    results,
  });
}
