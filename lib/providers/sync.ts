import "server-only";
import { supabaseService } from "@/lib/supabase/service";
import { resolveServerCredentials } from "@/lib/vault/resolve";
import { putSecret } from "@/lib/vault/secrets";
import { audit } from "@/lib/vault/audit";
import { getProvider } from "./registry";
import type { Discovered, ProviderId } from "./types";

/**
 * Account discovery: reconcile what the provider says exists against what the registry holds.
 *
 * Computed as a plan first and applied second, so the UI can show exactly what will change
 * before anything is written. Nothing is ever deleted — a project that has disappeared from
 * the provider is reported, not removed, because "the token lost access to that organization"
 * and "the project is gone" look identical from here and only one of them is safe to act on.
 */
export type SyncPlan = {
  provider: ProviderId;
  accountId: string;
  /** In the provider but not the registry. */
  toCreate: Discovered[];
  /** In both, with something worth updating. */
  toUpdate: { id: string; name: string; changes: Record<string, { from: unknown; to: unknown }>; discovered: Discovered }[];
  /** In both and already in step. */
  unchanged: number;
  /** In the registry under this account but no longer visible to the token. */
  missing: { id: string; name: string; externalId: string }[];
  /** Registered under a different account of yours, so it would be re-homed. */
  reassigned: { id: string; name: string; externalId: string; fromAccountId: string | null }[];
};

type ProjectRow = {
  id: string;
  account_id: string | null;
  external_id: string;
  name: string;
  region: string | null;
  provider_status: string | null;
  lifecycle: string;
  metadata: Record<string, unknown>;
};

export async function planSync(
  userId: string,
  accountId: string,
  provider: ProviderId,
): Promise<SyncPlan> {
  const adapter = getProvider(provider);
  if (!adapter.discover) {
    throw new Error(`${adapter.name} doesn't support automatic discovery.`);
  }

  const credentials = await resolveServerCredentials(userId, { accountId });
  const discovered = await adapter.discover(credentials);

  const db = supabaseService();
  const { data, error } = await db
    .from("projects")
    .select("id, account_id, external_id, name, region, provider_status, lifecycle, metadata")
    .eq("user_id", userId)
    .eq("provider", provider);
  if (error) throw error;

  const existing = (data ?? []) as ProjectRow[];
  const byExternalId = new Map(existing.map((p) => [p.external_id, p]));
  const discoveredIds = new Set(discovered.map((d) => d.externalId));

  const plan: SyncPlan = {
    provider,
    accountId,
    toCreate: [],
    toUpdate: [],
    unchanged: 0,
    missing: [],
    reassigned: [],
  };

  for (const d of discovered) {
    const row = byExternalId.get(d.externalId);

    if (!row) {
      plan.toCreate.push(d);
      continue;
    }

    if (row.account_id !== accountId) {
      plan.reassigned.push({
        id: row.id,
        name: row.name,
        externalId: row.external_id,
        fromAccountId: row.account_id,
      });
      continue;
    }

    // Only fields the provider is authoritative about. The user's own name, notes, repo URL
    // and keep-alive settings are never overwritten by a sync.
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (d.providerStatus && d.providerStatus !== row.provider_status) {
      changes.provider_status = { from: row.provider_status, to: d.providerStatus };
    }
    if (d.lifecycle !== row.lifecycle) {
      changes.lifecycle = { from: row.lifecycle, to: d.lifecycle };
    }
    if (d.region && d.region !== row.region) {
      changes.region = { from: row.region, to: d.region };
    }

    if (Object.keys(changes).length > 0) {
      plan.toUpdate.push({ id: row.id, name: row.name, changes, discovered: d });
    } else {
      plan.unchanged++;
    }
  }

  for (const row of existing) {
    if (row.account_id === accountId && !discoveredIds.has(row.external_id)) {
      plan.missing.push({ id: row.id, name: row.name, externalId: row.external_id });
    }
  }

  return plan;
}

export type SyncResult = { created: number; updated: number; reassigned: number; keysFetched: number };

/**
 * Apply a plan.
 *
 * Re-plans rather than trusting a plan from the client: the browser round-trip is long enough
 * for a project to be created or paused in the provider's console, and a stale plan would
 * write stale values.
 */
export async function applySync(
  userId: string,
  accountId: string,
  provider: ProviderId,
  options: { adoptReassigned?: boolean; fetchCredentials?: boolean } = {},
): Promise<SyncResult> {
  const adapter = getProvider(provider);
  const plan = await planSync(userId, accountId, provider);
  const db = supabaseService();
  const credentials = await resolveServerCredentials(userId, { accountId });

  const result: SyncResult = { created: 0, updated: 0, reassigned: 0, keysFetched: 0 };

  for (const d of plan.toCreate) {
    const { data, error } = await db
      .from("projects")
      .insert({
        user_id: userId,
        account_id: accountId,
        provider,
        external_id: d.externalId,
        name: d.name,
        region: d.region,
        plan: d.plan,
        provider_status: d.providerStatus,
        lifecycle: d.lifecycle,
        strategy: adapter.policy.strategy,
        interval_days: adapter.policy.defaultIntervalDays,
        // Imported projects start with keep-alive OFF. Switching it on silently would start
        // sending traffic to someone's project on their behalf without being asked.
        keep_alive: false,
        metadata: d.metadata,
        discovered_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error) continue;
    result.created++;

    if (options.fetchCredentials && adapter.fetchProjectCredentials) {
      const fetched = await adapter
        .fetchProjectCredentials(
          { externalId: d.externalId, name: d.name, metadata: d.metadata },
          credentials,
        )
        .catch(() => ({}));

      for (const [kind, value] of Object.entries(fetched)) {
        try {
          await putSecret(userId, { projectId: data.id as string }, kind as never, "server", value, "Fetched during sync");
          result.keysFetched++;
        } catch {
          // A failed key fetch must not undo the import.
        }
      }
    }
  }

  for (const u of plan.toUpdate) {
    const patch: Record<string, unknown> = {};
    for (const [field, change] of Object.entries(u.changes)) patch[field] = change.to;
    const { error } = await db.from("projects").update(patch).eq("id", u.id);
    if (!error) result.updated++;
  }

  if (options.adoptReassigned) {
    for (const r of plan.reassigned) {
      const { error } = await db.from("projects").update({ account_id: accountId }).eq("id", r.id);
      if (!error) result.reassigned++;
    }
  }

  await db
    .from("accounts")
    .update({
      last_synced_at: new Date().toISOString(),
      last_sync_status: "ok",
      last_sync_error: null,
    })
    .eq("id", accountId);

  await audit(userId, {
    action: "secret.migrated",
    targetType: "account",
    targetId: accountId,
    detail: { event: "account.synced", provider, ...result },
  });

  return result;
}

export async function recordSyncFailure(
  accountId: string,
  message: string,
): Promise<void> {
  await supabaseService()
    .from("accounts")
    .update({
      last_synced_at: new Date().toISOString(),
      last_sync_status: "error",
      last_sync_error: message.slice(0, 500),
    })
    .eq("id", accountId);
}
