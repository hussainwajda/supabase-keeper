import { projects } from "../db/collections";
import type { ProjectDoc } from "../db/documents";
import { newId } from "../db/ids";
import { owned, type Scope } from "../db/scope";
import { badRequest } from "../http/errors";
import { recordSyncSuccess } from "../registry/accounts";
import { resolveServerCredentials } from "../vault/resolve";
import { putSecret } from "../vault/secrets";
import { audit, type RequestOrigin } from "../vault/audit";
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
  toUpdate: {
    id: string;
    name: string;
    changes: Record<string, { from: unknown; to: unknown }>;
    discovered: Discovered;
  }[];
  /** In both and already in step. */
  unchanged: number;
  /** In the registry under this account but no longer visible to the token. */
  missing: { id: string; name: string; externalId: string }[];
  /** Registered under a different account of yours, so it would be re-homed. */
  reassigned: { id: string; name: string; externalId: string; fromAccountId: string | null }[];
};

export async function planSync(
  scope: Scope,
  accountId: string,
  provider: ProviderId,
): Promise<SyncPlan> {
  const adapter = getProvider(provider);
  if (!adapter.discover) {
    throw badRequest(`${adapter.name} doesn't support automatic discovery.`);
  }

  const credentials = await resolveServerCredentials(scope, { accountId });
  const discovered = await adapter.discover(credentials);

  const existing = await projects().find({ ...owned(scope), provider }).toArray();
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
        id: row._id,
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
      plan.toUpdate.push({ id: row._id, name: row.name, changes, discovered: d });
    } else {
      plan.unchanged++;
    }
  }

  for (const row of existing) {
    if (row.account_id === accountId && !discoveredIds.has(row.external_id)) {
      plan.missing.push({ id: row._id, name: row.name, externalId: row.external_id });
    }
  }

  return plan;
}

export type SyncResult = {
  created: number;
  updated: number;
  reassigned: number;
  keysFetched: number;
};

/**
 * Apply a plan.
 *
 * Re-plans rather than trusting a plan from the client: the round trip is long enough for a
 * project to be created or paused in the provider's console, and a stale plan would write
 * stale values. With a REST API in front of this the gap is wider than it was with a server
 * action, which makes the re-plan more necessary rather than less.
 */
export async function applySync(
  scope: Scope,
  accountId: string,
  provider: ProviderId,
  options: { adoptReassigned?: boolean; fetchCredentials?: boolean } = {},
  origin?: RequestOrigin,
): Promise<SyncResult> {
  const adapter = getProvider(provider);
  const plan = await planSync(scope, accountId, provider);
  const credentials = await resolveServerCredentials(scope, { accountId });

  const result: SyncResult = { created: 0, updated: 0, reassigned: 0, keysFetched: 0 };

  for (const d of plan.toCreate) {
    const doc: ProjectDoc = {
      _id: newId(),
      user_id: scope.userId,
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
      repo_url: null,
      local_path: null,
      notes: null,
      metadata: d.metadata,
      last_pinged_at: null,
      last_status: null,
      last_error: null,
      discovered_at: new Date(),
      created_at: new Date(),
    };

    try {
      await projects().insertOne(doc);
    } catch {
      // A duplicate means it was imported between the plan and the apply. Skip it.
      continue;
    }
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
          await putSecret({
            scope,
            owner: { projectId: doc._id },
            kind,
            tier: "server",
            value,
            label: "Fetched during sync",
            origin,
          });
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
    const { modifiedCount } = await projects().updateOne(
      { ...owned(scope), _id: u.id },
      { $set: patch },
    );
    if (modifiedCount) result.updated++;
  }

  if (options.adoptReassigned) {
    for (const r of plan.reassigned) {
      const { modifiedCount } = await projects().updateOne(
        { ...owned(scope), _id: r.id },
        { $set: { account_id: accountId } },
      );
      if (modifiedCount) result.reassigned++;
    }
  }

  await recordSyncSuccess(scope, accountId);

  await audit(
    scope.userId,
    {
      action: "secret.migrated",
      targetType: "account",
      targetId: accountId,
      detail: { event: "account.synced", provider, ...result },
    },
    origin,
  );

  return result;
}
