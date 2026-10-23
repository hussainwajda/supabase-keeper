import "server-only";
import { supabaseService } from "@/lib/supabase/service";
import { sealServerSecret } from "@/lib/crypto/secrets";
import { vaultConfigured } from "@/lib/crypto/env";
import { audit } from "./audit";
import { usingNodeBackend } from "@/lib/backend/env";

/**
 * Move plaintext `projects.anon_key` values into encrypted `server`-tier secrets.
 *
 * This can't be a SQL migration: encrypting needs `KEEPSTACK_MASTER_KEY`, which lives in the
 * application environment and deliberately never reaches the database. So migration 0005
 * creates the tables, this moves the data, and 0006 drops the column — refusing to run while
 * anything is still in it.
 *
 * The order inside the loop matters: write the encrypted copy, confirm it, and only then null
 * the plaintext. A crash midway leaves a project with both copies, which the fallback in
 * `lib/ping.ts` handles, rather than neither.
 */
export type KeyMigrationStatus = {
  /** Projects still holding a plaintext key. */
  pending: number;
  /** True when the `anon_key` column is already gone (0006 has run). */
  columnDropped: boolean;
};

export async function keyMigrationStatus(): Promise<KeyMigrationStatus> {
  // The Node backend never had a plaintext `anon_key` field, so there is nothing pending and
  // the dashboard's "encrypt your saved keys" banner should stay hidden. (Any plaintext keys
  // in a migrated Supabase registry were encrypted by the migration script itself.)
  if (usingNodeBackend()) return { pending: 0, columnDropped: true };

  const { count, error } = await supabaseService()
    .from("projects")
    .select("id", { count: "exact", head: true })
    .not("anon_key", "is", null);

  // 42703 = undefined_column, i.e. migration 0006 has already dropped it.
  if (error?.code === "42703") return { pending: 0, columnDropped: true };
  if (error) throw error;

  return { pending: count ?? 0, columnDropped: false };
}

export type MigrationResult = { moved: number; skipped: number; failed: number };

export async function migratePlaintextKeys(userId: string): Promise<MigrationResult> {
  if (!vaultConfigured()) {
    throw new Error(
      "Set KEEPSTACK_MASTER_KEY and KEEPSTACK_PIN_PEPPER before migrating keys, or there is nothing to encrypt them with.",
    );
  }

  const db = supabaseService();
  const { data, error } = await db
    .from("projects")
    .select("id, name, anon_key")
    .eq("user_id", userId)
    .not("anon_key", "is", null);
  if (error) throw error;

  const result: MigrationResult = { moved: 0, skipped: 0, failed: 0 };

  for (const row of (data ?? []) as { id: string; name: string; anon_key: string | null }[]) {
    const value = row.anon_key;
    if (!value) {
      result.skipped++;
      continue;
    }

    try {
      const ciphertext = sealServerSecret(value, userId, "anon_key");

      const existing = await db
        .from("secrets")
        .select("id")
        .eq("user_id", userId)
        .eq("project_id", row.id)
        .eq("kind", "anon_key")
        .maybeSingle();

      if (existing.data?.id) {
        const { error: updateError } = await db
          .from("secrets")
          .update({ ciphertext, tier: "server" })
          .eq("id", existing.data.id);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await db.from("secrets").insert({
          user_id: userId,
          project_id: row.id,
          kind: "anon_key",
          tier: "server",
          label: "Imported from the plaintext column",
          ciphertext,
        });
        if (insertError) throw insertError;
      }

      // Only now is it safe to drop the plaintext.
      const { error: clearError } = await db
        .from("projects")
        .update({ anon_key: null })
        .eq("id", row.id);
      if (clearError) throw clearError;

      result.moved++;
    } catch (e) {
      result.failed++;
      // Message only: a structured driver error can echo the request payload, and nothing
      // from a secrets write belongs in a log line.
      console.error(
        `[keepstack] could not migrate the key for project ${row.id}: ${(e as Error).message}`,
      );
    }
  }

  await audit(userId, {
    action: "secret.migrated",
    detail: { kind: "anon_key", ...result },
  });

  return result;
}
