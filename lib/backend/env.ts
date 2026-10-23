/**
 * Which backend is serving this deployment.
 *
 * Keepstack has two, and they are not layered — they are alternatives:
 *
 *   supabase  Next.js server actions query a Supabase Postgres registry in-process,
 *             and Supabase Auth provides identity. The default.
 *   node      Next.js calls the REST service in `backend-node/` over HTTP, which keeps its
 *             data in MongoDB and owns identity itself.
 *
 * Switched with one variable, so nothing in the app has to be rebuilt or reconfigured:
 *
 *   KEEPSTACK_BACKEND=node
 *   KEEPSTACK_API_URL=http://127.0.0.1:4000
 *
 * `pnpm dev --nodejs` sets both for you — see `scripts/dev.mjs`.
 */
export type BackendId = "supabase" | "node";

/**
 * Not `NEXT_PUBLIC_`, deliberately. Which backend is in use is a server-side fact, and
 * baking it into the client bundle would mean a browser could be told one thing while the
 * server does another. The handful of client components that need to vary are passed a prop
 * by the server component that renders them.
 */
export function activeBackend(): BackendId {
  return process.env.KEEPSTACK_BACKEND?.trim().toLowerCase() === "node" ? "node" : "supabase";
}

export const usingNodeBackend = (): boolean => activeBackend() === "node";

/**
 * Where the Node backend lives.
 *
 * `127.0.0.1` rather than `localhost` as the default: on a machine that resolves `localhost`
 * to `::1` first, Node's fetch will try IPv6, and a backend bound to IPv4 refuses it. That
 * failure reads as "backend down" and costs an hour.
 */
export function apiBaseUrl(): string {
  const configured = process.env.KEEPSTACK_API_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (usingNodeBackend()) {
    throw new Error(
      "KEEPSTACK_BACKEND=node but KEEPSTACK_API_URL is not set. Point it at the backend-node service, e.g. http://127.0.0.1:4000.",
    );
  }
  return "http://127.0.0.1:4000";
}

/**
 * Concepts that only exist on one side, so a caller can say so honestly rather than
 * guessing. All three are artefacts of the Supabase registry being migrated by hand:
 *
 *  - `schemaStatus()` / `vaultSchemaReady()` ask whether a SQL file has been run yet.
 *  - the legacy claim adopts rows that predate authentication.
 *  - the plaintext-key migration moves `projects.anon_key` into the vault.
 *
 * The Node backend applies its indexes at boot and was never storing a plaintext key, so for
 * it the answer to each is "not applicable" rather than "yes" or "no" — and the UI should
 * hide those banners instead of rendering a reassuring green tick for a question that makes
 * no sense.
 */
export function supportsLegacyMigrations(): boolean {
  return activeBackend() === "supabase";
}
