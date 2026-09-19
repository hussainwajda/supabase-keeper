import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/auth";
import { pingProjects } from "@/lib/ping";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Vercel Cron calls this daily (see vercel.json) with `Authorization: Bearer $CRON_SECRET`.
// Each project is only pinged when it's due according to its own interval_days.
// Add ?force=1 to ping every keep-alive project regardless of schedule.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const results = await pingProjects({ force: req.nextUrl.searchParams.get("force") === "1" });
  const failed = results.filter((r) => r.status === "error");
  if (failed.length) console.error("keep-alive failures", failed);

  return NextResponse.json({
    pinged: results.length,
    ok: results.length - failed.length,
    failed: failed.length,
    results,
  });
}
