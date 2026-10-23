import { accounts, pingLogs, projects, secrets, usageSnapshots } from "../db/collections";
import type { AccountDoc, ProjectDoc } from "../db/documents";
import { newId } from "../db/ids";
import { owned, type Scope } from "../db/scope";
import {
  asBoolean,
  asIntervalDays,
  asLifecycle,
  asMetadata,
  asProviderId,
  asStrategy,
  optionalString,
  requireString,
} from "../db/validate";
import { badRequest, notFound } from "../http/errors";
import { toAccount, toPingLog, toProject, toProjectWithAccount } from "../http/serialize";
import { listAccounts } from "./accounts";
import { projectIdsWithStoredKey } from "../vault/secrets";
import { getProvider } from "../providers/registry";

export async function listProjects(scope: Scope) {
  const docs = await projects().find(owned(scope)).sort({ name: 1 }).toArray();

  /*
   * The account is attached with a second query rather than an aggregation `$lookup`.
   *
   * `$lookup` would be one round trip instead of two, which is the argument for it, and
   * against: a user has a handful of accounts and tens of projects, so this fetches a few
   * documents and joins them in memory, while `$lookup` runs a per-document subquery and
   * returns the same account embedded once per project that references it. The Supabase
   * version wrote `.select("*, account:accounts(*)")` and got the same embedding for the same
   * cost; two indexed queries is cheaper here and the resulting JSON is identical.
   */
  const accountIds = [...new Set(docs.map((p) => p.account_id).filter((id): id is string => !!id))];
  const accountDocs = accountIds.length
    ? await accounts().find({ ...owned(scope), _id: { $in: accountIds } }).toArray()
    : [];
  const byId = new Map(accountDocs.map((a) => [a._id, a]));

  return docs.map((p) => toProjectWithAccount(p, p.account_id ? byId.get(p.account_id) ?? null : null));
}

export async function findProject(scope: Scope, id: string): Promise<ProjectDoc> {
  const doc = await projects().findOne({ ...owned(scope), _id: id });
  if (!doc) throw notFound("That project doesn't exist, or isn't yours.");
  return doc;
}

export async function getProjectWithAccount(scope: Scope, id: string) {
  const project = await findProject(scope, id);
  const account: AccountDoc | null = project.account_id
    ? await accounts().findOne({ ...owned(scope), _id: project.account_id })
    : null;
  return toProjectWithAccount(project, account);
}

/**
 * Create a project from an API body.
 *
 * The identifier goes through the adapter's `parse()` exactly as `saveProject` does, so the
 * paste-anything behaviour — a dashboard URL, a connection string, a whole `.env` file —
 * works over the API too, and the adapter's own field validators run before anything is
 * written.
 */
export async function createProject(scope: Scope, body: Record<string, unknown>) {
  const provider = asProviderId(body.provider ?? "supabase");
  const adapter = getProvider(provider);

  const raw = requireString(body.external_id, "external_id");
  const parsed = adapter.parse(raw);
  if (!parsed) {
    throw badRequest(
      `Couldn't find a ${adapter.name} project identifier in that. Send the project URL or the identifier itself.`,
    );
  }

  validateProviderFields(provider, body);

  const doc: ProjectDoc = {
    _id: newId(),
    user_id: scope.userId,
    account_id: optionalString(body.account_id),
    provider,
    external_id: parsed.externalId,
    name: optionalString(body.name) ?? parsed.externalId,
    region: optionalString(body.region),
    plan: optionalString(body.plan),
    provider_status: optionalString(body.provider_status),
    lifecycle: asLifecycle(body.lifecycle, "unknown"),
    // Seeded from the adapter's policy, not taken from the client: `strategy` is a property
    // of the provider, and storing it keeps old ping_logs interpretable if the provider's
    // rules later change.
    strategy: adapter.policy.strategy,
    keep_alive: asBoolean(body.keep_alive, false),
    interval_days: asIntervalDays(body.interval_days, adapter.policy.defaultIntervalDays),
    repo_url: optionalString(body.repo_url),
    local_path: optionalString(body.local_path),
    notes: optionalString(body.notes),
    metadata: asMetadata(body.metadata),
    last_pinged_at: null,
    last_status: null,
    last_error: null,
    discovered_at: null,
    created_at: new Date(),
  };

  await projects().insertOne(doc);
  return toProject(doc);
}

export async function updateProject(scope: Scope, id: string, body: Record<string, unknown>) {
  const existing = await findProject(scope, id);
  const provider = body.provider !== undefined ? asProviderId(body.provider) : existing.provider;
  const adapter = getProvider(provider);

  const patch: Partial<ProjectDoc> = {};

  if (body.external_id !== undefined) {
    const parsed = adapter.parse(requireString(body.external_id, "external_id"));
    if (!parsed) {
      throw badRequest(`Couldn't find a ${adapter.name} project identifier in that.`);
    }
    patch.external_id = parsed.externalId;
  }

  if (body.provider !== undefined && provider !== existing.provider) {
    patch.provider = provider;
    // The strategy belongs to the provider, so changing one changes the other.
    patch.strategy = adapter.policy.strategy;
  }
  if (body.strategy !== undefined) patch.strategy = asStrategy(body.strategy, existing.strategy);

  validateProviderFields(provider, body);

  if (body.name !== undefined) patch.name = requireString(body.name, "name");
  if (body.account_id !== undefined) patch.account_id = optionalString(body.account_id);
  if (body.region !== undefined) patch.region = optionalString(body.region);
  if (body.plan !== undefined) patch.plan = optionalString(body.plan);
  if (body.repo_url !== undefined) patch.repo_url = optionalString(body.repo_url);
  if (body.local_path !== undefined) patch.local_path = optionalString(body.local_path);
  if (body.notes !== undefined) patch.notes = optionalString(body.notes);
  if (body.keep_alive !== undefined) patch.keep_alive = asBoolean(body.keep_alive, existing.keep_alive);
  if (body.lifecycle !== undefined) patch.lifecycle = asLifecycle(body.lifecycle, existing.lifecycle);
  if (body.interval_days !== undefined) {
    patch.interval_days = asIntervalDays(body.interval_days, existing.interval_days);
  }

  /*
   * Metadata is merged, never replaced.
   *
   * Same reason `saveProject` merges it: discovery writes provider-specific keys in there
   * (`org_slug`, `group_id`, `endpoint`, `srv_host`), and a PATCH that happens to carry a
   * `metadata` object would otherwise wipe whatever the last sync learned. Sending an
   * explicit `null` for a key removes it, which is how `ping_table` gets cleared.
   */
  if (body.metadata !== undefined) {
    const merged = { ...existing.metadata, ...asMetadata(body.metadata) };
    for (const [key, value] of Object.entries(merged)) {
      if (value === null) delete merged[key];
    }
    patch.metadata = merged;
  }

  if (Object.keys(patch).length === 0) return toProject(existing);

  const updated = await projects().findOneAndUpdate(
    { ...owned(scope), _id: id },
    { $set: patch },
    { returnDocument: "after" },
  );
  if (!updated) throw notFound("That project doesn't exist, or isn't yours.");
  return toProject(updated);
}

/**
 * Run the adapter's own field validators.
 *
 * This is what gives every provider the "you pasted the wrong key" protection that used to be
 * a hardcoded anon-key check — the adapter declares the rule, so a new provider gets it by
 * declaring one rather than by someone remembering to add a branch here.
 */
function validateProviderFields(
  provider: ProjectDoc["provider"],
  body: Record<string, unknown>,
): void {
  for (const field of getProvider(provider).projectFields) {
    const value = body[field.key];
    if (typeof value !== "string" || !value.trim() || !field.validate) continue;
    const problem = field.validate(value.trim());
    if (problem) throw badRequest(problem);
  }
}

/**
 * Delete a project and everything that hung off it.
 *
 * In SQL all three of these were `on delete cascade`. Children first, parent last, for the
 * reason set out in `deleteAccount` — a crash partway through should leave something the user
 * can retry, not rows that exist but are unreachable.
 */
export async function deleteProject(scope: Scope, id: string): Promise<void> {
  await findProject(scope, id);

  await Promise.all([
    pingLogs().deleteMany({ ...owned(scope), project_id: id }),
    usageSnapshots().deleteMany({ ...owned(scope), project_id: id }),
    secrets().deleteMany({ ...owned(scope), project_id: id }),
  ]);
  await projects().deleteOne({ ...owned(scope), _id: id });
}

export async function recentLogs(scope: Scope, projectId: string, limit = 15) {
  await findProject(scope, projectId);
  const docs = await pingLogs()
    .find({ ...owned(scope), project_id: projectId })
    .sort({ created_at: -1 })
    .limit(Math.min(200, Math.max(1, limit)))
    .toArray();
  return docs.map(toPingLog);
}

/**
 * Every project with keep-alive enabled, across all users.
 *
 * The one query in this backend that is deliberately not scoped, and the comment matters
 * because the rule everywhere else is that an unscoped read is a bug. In Postgres this was
 * the service-role call: the nightly sweep has no user session and must cover everybody.
 * Here, `userId` narrows it when a signed-in user presses "Ping all now", so one person's
 * action never pulls another person's projects into the process at all — and the cron omits
 * it on purpose.
 */
export async function keepAliveProjects(userId?: string): Promise<ProjectDoc[]> {
  const filter: Record<string, unknown> = { keep_alive: true };
  if (userId) filter.user_id = userId;
  return projects().find(filter).toArray();
}

/**
 * Full registry export.
 *
 * Secrets are excluded, so the downloaded file is safe to keep on disk — the same promise the
 * Supabase export makes, and worth keeping because this is the thing you take before doing
 * anything risky to your data. Runs scoped, so you can only ever export your own documents.
 */
export async function exportRegistry(scope: Scope) {
  const [accountList, projectList, logs, usage] = await Promise.all([
    listAccounts(scope),
    projects().find(owned(scope)).sort({ name: 1 }).toArray(),
    pingLogs().find(owned(scope)).sort({ created_at: -1 }).limit(5000).toArray(),
    usageSnapshots().find(owned(scope)).sort({ captured_at: -1 }).limit(5000).toArray(),
  ]);

  // The same question the dashboard badge asks, answered the same way, so an export can't
  // disagree with the screen it was taken from.
  const exported = projectList.map(toProject);
  const withKeys = await projectIdsWithStoredKey(scope, exported);

  return {
    keepstack_export_version: 1,
    backend: "node-mongodb",
    exported_at: new Date().toISOString(),
    note: "Secrets (anon keys, tokens, passwords) are intentionally excluded from exports.",
    accounts: accountList.map(toAccount),
    projects: exported.map((p) => ({ ...p, has_key: withKeys.has(p.id) })),
    ping_logs: logs.map(toPingLog),
    usage_snapshots: usage.map((u) => ({
      id: u._id,
      project_id: u.project_id,
      metric: u.metric,
      value: u.value,
      limit_value: u.limit_value,
      unit: u.unit,
      captured_at: u.captured_at.toISOString(),
      captured_on: u.captured_on,
    })),
  };
}

