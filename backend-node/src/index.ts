import { port, schedulerEnabled } from "./config/env";
import { closeMongo, connectMongo } from "./db/client";
import { ensureIndexes } from "./db/indexes";
import { vaultEnvProblems } from "./crypto/env";
import { createApp } from "./server";
import { startScheduler, stopScheduler } from "./jobs/scheduler";

/**
 * Boot.
 *
 * The order is the point: connect, apply the indexes, *then* listen. Applying indexes before
 * serving is what lets this backend have no migration files and no runtime schema checks — in
 * the Supabase app, `schemaStatus()` and `vaultSchemaReady()` exist solely because the SQL is
 * run by a human at some unknown time relative to the deploy, so reads have to degrade and
 * writes have to narrow for the window in between. Here the constraints are in place before
 * the first request can arrive, so there is no window and no degraded mode to maintain.
 */
async function main(): Promise<void> {
  /*
   * A missing or malformed KEEPSTACK_MASTER_KEY is a warning, not a fatal error.
   *
   * It would be tempting to refuse to start. But the sweep is the part of this that has to
   * keep running unattended, and it doesn't need the vault for a project whose credentials
   * are public — so exiting here would stop keep-alives from working in order to complain
   * about a feature that isn't in use. Every path that actually needs a key calls
   * `assertVaultEnv()` and fails with this same list.
   */
  const problems = vaultEnvProblems();
  if (problems.length) {
    console.warn(
      `[keepstack:backend] the vault is not fully configured, so storing and reading secrets will fail:\n- ${problems.join("\n- ")}`,
    );
  }

  await connectMongo();
  console.log("[keepstack:backend] connected to MongoDB");

  await ensureIndexes();
  console.log("[keepstack:backend] indexes applied");

  const app = createApp();
  const server = app.listen(port(), () => {
    console.log(`[keepstack:backend] listening on http://localhost:${port()}`);
  });

  if (schedulerEnabled()) startScheduler();

  /**
   * Graceful shutdown.
   *
   * Stop taking new connections, let in-flight requests finish, then close the driver's pool.
   * A sweep holds open sockets to four providers and may be mid-write to MongoDB, so dropping
   * the process on the first signal risks a half-written ping log. The second signal is
   * honoured immediately, because an operator pressing Ctrl-C twice means it.
   */
  let shuttingDown = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (shuttingDown) {
        console.warn(`[keepstack:backend] ${signal} again — exiting now`);
        process.exit(1);
      }
      shuttingDown = true;
      console.log(`[keepstack:backend] ${signal} received, shutting down`);

      stopScheduler();
      server.close(() => {
        void closeMongo().then(() => process.exit(0));
      });

      // Don't hang forever on a connection that refuses to close.
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }
}

main().catch((e) => {
  console.error("[keepstack:backend] failed to start:", (e as Error).message);
  process.exit(1);
});
