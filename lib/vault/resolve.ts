import "server-only";
import { supabaseService } from "@/lib/supabase/service";
import { openServerSecret } from "@/lib/crypto/secrets";
import { vaultConfigured } from "@/lib/crypto/env";
import type { Credentials } from "@/lib/providers/types";

/**
 * Gather the `server`-tier credentials an adapter needs, decrypted.
 *
 * Adapters take a flat `Credentials` map and never touch the database, so something has to
 * assemble it. Account-level credentials (a Supabase PAT, an Upstash email + key) and
 * project-level ones (an anon key, a REST token) are merged here, with project values winning
 * on a key collision — the more specific credential should override the account default.
 *
 * `personal`-tier rows are deliberately skipped: this runs unattended in the nightly sweep,
 * where the user's key isn't available by design. Anything the sweep needs must be `server`.
 */
export async function resolveServerCredentials(
  userId: string,
  opts: { accountId?: string | null; projectId?: string | null },
): Promise<Credentials> {
  if (!vaultConfigured()) return {};

  const owners = [opts.accountId, opts.projectId].filter(Boolean) as string[];
  if (owners.length === 0) return {};

  const db = supabaseService();
  const { data, error } = await db
    .from("secrets")
    .select("id, kind, tier, ciphertext, account_id, project_id")
    .eq("user_id", userId)
    .eq("tier", "server")
    .or(
      [
        opts.accountId ? `account_id.eq.${opts.accountId}` : null,
        opts.projectId ? `project_id.eq.${opts.projectId}` : null,
      ]
        .filter(Boolean)
        .join(","),
    );

  if (error || !data) return {};

  const credentials: Credentials = {};
  const usedIds: string[] = [];

  // Account rows first so project rows overwrite them.
  const ordered = [...data].sort((a, b) => (a.project_id ? 1 : 0) - (b.project_id ? 1 : 0));

  for (const row of ordered) {
    const value = openServerSecret(row.ciphertext as string, userId, row.kind as string);
    if (value === null) continue; // Wrong master key, or a tampered row: skip, don't throw.
    credentials[row.kind as string] = value;
    usedIds.push(row.id as string);
  }

  if (usedIds.length) {
    await db
      .from("secrets")
      .update({ last_used_at: new Date().toISOString() })
      .in("id", usedIds);
  }

  return credentials;
}
