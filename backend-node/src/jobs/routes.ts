import { Router } from "express";
import { cronSecret } from "../config/env";
import { safeEqual } from "../lib/safe-equal";
import { handler } from "../http/handler";
import { ApiError } from "../http/errors";
import { PROVIDER_IDS, type ProviderId } from "../providers/types";
import { pruneExpiredSessions } from "../vault/session";
import { pingProjects } from "./ping";
import { summarise } from "./summary";

export const cronRoutes = Router();

/**
 * The sweep, exposed over HTTP.
 *
 * Same contract as the Next.js app's `/api/cron/sweep`: `Authorization: Bearer $CRON_SECRET`,
 * because a scheduler has no user session to present. Kept identical on purpose — an existing
 * Vercel Cron entry, GitHub Actions workflow or `curl` in a crontab points at this with no
 * change but the host.
 *
 * Unlike the Vercel route, this one has a sibling: `ENABLE_SCHEDULER=true` runs the same
 * sweep from inside the process (`src/jobs/scheduler.ts`), so a self-hosted deployment needs
 * nothing external at all. The endpoint stays because an endpoint is still the only way to
 * trigger a run by hand, and because a platform scheduler is the right answer when the
 * process might not be running continuously.
 */
const authorize = (header: string | undefined): void => {
  const secret = cronSecret();
  if (!secret) {
    throw new ApiError(
      503,
      "CRON_SECRET is not set, so the sweep endpoint is disabled. Set it, or run the sweep in-process with ENABLE_SCHEDULER=true.",
      "not_configured",
    );
  }
  if (!safeEqual(header ?? "", `Bearer ${secret}`)) {
    throw new ApiError(401, "unauthorized", "unauthorized");
  }
};

const runSweep = handler(async (req, res) => {
  authorize(req.get("authorization"));

  const providerParam = req.query.provider;
  const provider = PROVIDER_IDS.includes(providerParam as ProviderId)
    ? (providerParam as ProviderId)
    : undefined;

  const results = await pingProjects({
    force: req.query.force === "1",
    provider,
  });

  // Expired sudo sessions and spent OTP challenges. Largely handled by the TTL indexes now;
  // doing it here as well makes expiry immediate rather than up to a minute late.
  const pruned = await pruneExpiredSessions();

  const summary = summarise(results);
  if (summary.failures.length) {
    console.error("[keepstack:backend] sweep failures", summary.failures);
  }

  res.json({ ...summary.payload, pruned, results });
});

// GET for schedulers that only issue GETs (Vercel Cron), POST because a sweep mutates state.
cronRoutes.get("/cron/sweep", runSweep);
cronRoutes.post("/cron/sweep", runSweep);
