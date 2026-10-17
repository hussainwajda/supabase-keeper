import "server-only";
import { supabaseService } from "@/lib/supabase/service";
import { supabaseServer } from "@/lib/supabase/server";
import {
  openPersonalSecret,
  openServerSecret,
  sealPersonalSecret,
  sealServerSecret,
  type SecretTier,
} from "@/lib/crypto/secrets";
import { assertVaultEnv } from "@/lib/crypto/env";
import { audit } from "./audit";
import { currentDek } from "./session";

export type SecretKind =
  | "account_password"
  | "pat"
  | "api_key"
  | "api_email"
  | "service_account"
  | "db_password"
  | "anon_key"
  | "connection_string"
  | "rest_token";

export type SecretOwner = { accountId?: string | null; projectId?: string | null };

/** Row shape as the UI sees it — never includes `ciphertext`. */
export type SecretSummary = {
  id: string;
  kind: SecretKind;
  label: string | null;
  tier: SecretTier;
  account_id: string | null;
  project_id: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

const SUMMARY_COLUMNS =
  "id, kind, label, tier, account_id, project_id, last_used_at, created_at, updated_at";

function ownerFilter<T>(query: T, owner: SecretOwner): T {
  const q = query as { eq: (c: string, v: string) => T; is: (c: string, v: null) => T };
  if (owner.projectId) return q.eq("project_id", owner.projectId);
  if (owner.accountId) return q.eq("account_id", owner.accountId);
  throw new Error("A secret must belong to either an account or a project.");
}

/**
 * List secrets for the inventory UI. Runs as the user, so RLS scopes it, and selects only the
 * summary columns — `select *` on this table is the thing docs/SECURITY.md §6 forbids.
 */
export async function listSecrets(owner?: SecretOwner): Promise<SecretSummary[]> {
  const db = await supabaseServer();
  let query = db.from("secrets").select(SUMMARY_COLUMNS).order("created_at");
  if (owner?.projectId) query = query.eq("project_id", owner.projectId);
  if (owner?.accountId) query = query.eq("account_id", owner.accountId);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as SecretSummary[];
}

/**
 * Store a secret, encrypting it according to its tier.
 *
 * A `personal` secret needs a live vault session, because its key is the user's DEK — which
 * the server only ever holds during an unlocked request. A `server` secret does not, because
 * the nightly sweep has to be able to read it unattended.
 */
export async function putSecret(
  userId: string,
  owner: SecretOwner,
  kind: SecretKind,
  tier: SecretTier,
  value: string,
  label?: string | null,
): Promise<void> {
  assertVaultEnv();
  if (!value.trim()) throw new Error("Nothing to store.");

  let ciphertext: string;
  if (tier === "server") {
    ciphertext = sealServerSecret(value, userId, kind);
  } else {
    const dek = await currentDek(userId);
    if (!dek) {
      throw new Error("Your vault is locked. Unlock it before saving a personal secret.");
    }
    ciphertext = sealPersonalSecret(value, dek, userId, kind);
  }

  const db = supabaseService();
  const existing = await ownerFilter(
    db.from("secrets").select("id").eq("user_id", userId).eq("kind", kind),
    owner,
  ).maybeSingle();

  if (existing.data?.id) {
    const { error } = await db
      .from("secrets")
      .update({ ciphertext, tier, label: label ?? null })
      .eq("id", existing.data.id);
    if (error) throw error;
    await audit(userId, {
      action: "secret.update",
      targetType: "secret",
      targetId: existing.data.id as string,
      detail: { kind, tier },
    });
    return;
  }

  const { data, error } = await db
    .from("secrets")
    .insert({
      user_id: userId,
      account_id: owner.accountId ?? null,
      project_id: owner.projectId ?? null,
      kind,
      tier,
      label: label ?? null,
      ciphertext,
    })
    .select("id")
    .single();
  if (error) throw error;

  await audit(userId, {
    action: "secret.create",
    targetType: "secret",
    targetId: data.id as string,
    detail: { kind, tier },
  });
}

/**
 * Decrypt a `server`-tier secret for unattended use (the sweep, provider discovery).
 *
 * Deliberately refuses `personal` rows: that refusal is the tier boundary in code, not just
 * in the AAD. Returns null rather than throwing so a single missing key doesn't abort a sweep.
 */
export async function readServerSecret(
  userId: string,
  owner: SecretOwner,
  kind: SecretKind,
): Promise<string | null> {
  const db = supabaseService();
  const { data } = await ownerFilter(
    db.from("secrets").select("id, ciphertext, tier").eq("user_id", userId).eq("kind", kind),
    owner,
  ).maybeSingle();

  if (!data) return null;
  if (data.tier !== "server") return null;

  const value = openServerSecret(data.ciphertext as string, userId, kind);
  if (value) {
    await db
      .from("secrets")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", data.id as string);
  }
  return value;
}

export type RevealResult =
  | { ok: true; value: string }
  | { ok: false; reason: "locked" | "not_found" | "undecryptable" };

/**
 * Reveal one secret to the signed-in user.
 *
 * Always audited, including the failures. `personal` rows need a live vault session;
 * `server` rows are shown too, because hiding an anon key from its owner would be theatre —
 * but the reveal is still gated on an unlock and still logged.
 */
export async function revealSecret(
  userId: string,
  secretId: string,
  method: "pin" | "otp" | null,
): Promise<RevealResult> {
  assertVaultEnv();

  const dek = await currentDek(userId);
  if (!dek) return { ok: false, reason: "locked" };

  const db = supabaseService();
  const { data } = await db
    .from("secrets")
    .select("id, kind, tier, ciphertext, label")
    .eq("id", secretId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return { ok: false, reason: "not_found" };

  const kind = data.kind as SecretKind;
  const value =
    data.tier === "server"
      ? openServerSecret(data.ciphertext as string, userId, kind)
      : openPersonalSecret(data.ciphertext as string, dek, userId, kind);

  if (value === null) {
    await audit(userId, {
      action: "secret.reveal",
      targetType: "secret",
      targetId: secretId,
      method,
      detail: { kind, tier: data.tier, outcome: "undecryptable" },
    });
    return { ok: false, reason: "undecryptable" };
  }

  await Promise.all([
    db.from("secrets").update({ last_used_at: new Date().toISOString() }).eq("id", secretId),
    audit(userId, {
      action: "secret.reveal",
      targetType: "secret",
      targetId: secretId,
      method,
      // The kind and label say *what* was revealed. The value is never recorded.
      detail: { kind, tier: data.tier, label: data.label ?? null },
    }),
  ]);

  return { ok: true, value };
}

export async function deleteSecret(userId: string, secretId: string): Promise<void> {
  const db = await supabaseServer();
  const { data } = await db.from("secrets").select("kind, tier").eq("id", secretId).maybeSingle();

  const { error } = await db.from("secrets").delete().eq("id", secretId);
  if (error) throw error;

  await audit(userId, {
    action: "secret.delete",
    targetType: "secret",
    targetId: secretId,
    detail: { kind: data?.kind ?? null, tier: data?.tier ?? null },
  });
}

/**
 * Project ids that have an `anon_key` stored in the vault.
 *
 * The dashboard's "missing anon key" warning used to read the plaintext column. Once that
 * column is gone (migration 0006) the only source of truth is here, so this keeps the
 * warning accurate across all three states: plaintext, encrypted, and neither.
 */
export async function projectIdsWithStoredKey(userId: string): Promise<Set<string>> {
  const { data, error } = await supabaseService()
    .from("secrets")
    .select("project_id")
    .eq("user_id", userId)
    .eq("kind", "anon_key")
    .not("project_id", "is", null);
  if (error) return new Set();
  return new Set((data ?? []).map((r) => r.project_id as string));
}

/**
 * Has migration 0005 been applied?
 *
 * Same lesson as `schemaStatus()` in the registry: the migrations are SQL files a human runs,
 * so there is always a window where the code is ahead of the schema. The vault UI shows a
 * "run this migration" notice in that window instead of a 500.
 *
 * Cached per process — the answer only changes when the SQL is run.
 */
let vaultSchemaApplied: boolean | null = null;

export async function vaultSchemaReady(): Promise<boolean> {
  if (vaultSchemaApplied !== null) return vaultSchemaApplied;
  const { error } = await supabaseService().from("secrets").select("id").limit(1);
  // PGRST205 = table not found in the schema cache; 42P01 = undefined_table.
  vaultSchemaApplied = !(error && (error.code === "PGRST205" || error.code === "42P01"));
  return vaultSchemaApplied;
}
