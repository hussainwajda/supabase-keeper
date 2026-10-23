import express, { type Express } from "express";
import { googleEnabled, schedulerEnabled } from "./config/env";
import { pingMongo } from "./db/client";
import { vaultConfigured } from "./crypto/env";
import { cors } from "./http/cors";
import { ApiError, errorHandler } from "./http/errors";
import { handler } from "./http/handler";
import { authRoutes } from "./auth/routes";
import { registryRoutes } from "./registry/routes";
import { providerRoutes } from "./providers/routes";
import { vaultRoutes } from "./vault/routes";
import { cronRoutes } from "./jobs/routes";
import { activeProviders } from "./providers/registry";

/**
 * The Express app.
 *
 * Assembled separately from `src/index.ts` so it can be built without listening on a port —
 * which is what makes it testable, and what the Next.js app got for free by not owning a
 * server at all.
 */
export function createApp(): Express {
  const app = express();

  // Express advertises itself in a response header by default. Nothing good comes of telling
  // the internet which framework and version is serving a credentials vault.
  app.disable("x-powered-by");

  // Behind a proxy (Fly, Render, nginx), trust its forwarded headers so `secure` cookies and
  // the IPs on audit entries are the client's rather than the proxy's.
  app.set("trust proxy", true);

  app.use(cors);

  /*
   * A body limit, which is not boilerplate here.
   *
   * The default is 100kb, which is already sane, but this API accepts pasted `.env` files and
   * connection strings, and the adapters' `parse()` functions run regexes over whatever
   * arrives. A megabyte is generous for a credential and small enough that no single request
   * can make a regex pass expensive.
   */
  app.use(express.json({ limit: "1mb" }));

  /**
   * Liveness and configuration, in one place.
   *
   * Reports what is configured rather than asserting that everything is — a deployment
   * missing `KEEPSTACK_MASTER_KEY` should be able to say so out loud. The equivalent in the
   * Next.js app is the `/setup` page plus `missingRegistryEnv()`.
   */
  app.get(
    "/health",
    handler(async (_req, res) => {
      const mongo = await pingMongo();
      res.status(mongo ? 200 : 503).json({
        ok: mongo,
        backend: "node-mongodb",
        mongo: mongo ? "connected" : "unreachable",
        vault: vaultConfigured() ? "configured" : "missing keys",
        google_auth: googleEnabled(),
        scheduler: schedulerEnabled() ? "in-process" : "external",
        providers: activeProviders().map((p) => p.id),
      });
    }),
  );

  /*
   * Four routers share the `/api` prefix, and a request that no earlier router matches falls
   * through to the next. That only works because authentication is attached per route rather
   * than per router: a router-level `use(requireUser)` would reject `/api/cron/sweep` and
   * `/api/providers` on the way past, which is a bug this once had. Mount order here is
   * therefore about readability, not about who can reach what.
   */
  app.use("/auth", authRoutes);
  app.use("/api", registryRoutes);
  app.use("/api", providerRoutes);
  app.use("/api/vault", vaultRoutes);
  app.use("/api", cronRoutes);

  // Anything unmatched is a 404 in the same envelope as every other error, so a client never
  // has to parse an HTML error page it wasn't expecting.
  app.use((req, _res, next) => {
    next(new ApiError(404, `No route for ${req.method} ${req.path}.`, "no_route"));
  });

  app.use(errorHandler);

  return app;
}
