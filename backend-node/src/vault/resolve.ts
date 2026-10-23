import { secrets } from "../db/collections";
import { owned, type Scope } from "../db/scope";
import { openServerSecret } from "../crypto/secrets";
import { vaultConfigured } from "../crypto/env";
import type { Credentials } from "../providers/types";

/**
 * Gather the `server`-tier credentials an adapter needs, decrypted.
 *
 * Adapters take a flat `Credentials` map and never touch the database, so something has to
 * assemble it. Account-level credentials (a Supabase PAT, an Upstash email + key) and
 * project-level ones (an anon key, a REST token) are merged here, with project values winning
 * on a key collision — the more specific credential should override the account default.
 *
 * `personal`-tier documents are deliberately skipped: this runs unattended in the nightly
 * sweep, where the user's key isn't available by design. Anything the sweep needs must be
 * `server`.
 *
 * The one thing that reads better here than in the Supabase version: that version had to
 * build the owner condition as a PostgREST `.or("account_id.eq.…,project_id.eq.…")` string,
 * which is string interpolation into a query language — safe in that case because both values
 * are UUIDs from our own database, but the kind of construction that stops being safe the
 * moment someone reuses the pattern with a value from a user. `$or` with real values has no
 * such edge.
 */
export async function resolveServerCredentials(
  scope: Scope,
  opts: { accountId?: string | null; projectId?: string | null },
): Promise<Credentials> {
  if (!vaultConfigured()) return {};

  const owners: Record<string, string>[] = [];
  if (opts.accountId) owners.push({ account_id: opts.accountId });
  if (opts.projectId) owners.push({ project_id: opts.projectId });
  if (owners.length === 0) return {};

  const docs = await secrets()
    .find({ ...owned(scope), tier: "server", $or: owners })
    .toArray();

  const credentials: Credentials = {};
  const usedIds: string[] = [];

  // Account documents first so project documents overwrite them.
  const ordered = [...docs].sort((a, b) => (a.project_id ? 1 : 0) - (b.project_id ? 1 : 0));

  for (const doc of ordered) {
    const value = openServerSecret(doc.ciphertext, scope.userId, doc.kind);
    if (value === null) continue; // Wrong master key, or a tampered document: skip, don't throw.
    credentials[doc.kind] = value;
    usedIds.push(doc._id);
  }

  if (usedIds.length) {
    await secrets().updateMany(
      { _id: { $in: usedIds } },
      { $set: { last_used_at: new Date() } },
    );
  }

  return credentials;
}
