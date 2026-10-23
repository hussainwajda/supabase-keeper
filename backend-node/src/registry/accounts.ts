import { accounts, projects, secrets } from "../db/collections";
import type { AccountDoc } from "../db/documents";
import { newId } from "../db/ids";
import { owned, type Scope } from "../db/scope";
import { asProviderId, optionalString, requireString } from "../db/validate";
import { notFound } from "../http/errors";
import { toAccount } from "../http/serialize";

export async function listAccounts(scope: Scope): Promise<AccountDoc[]> {
  return accounts().find(owned(scope)).sort({ created_at: 1 }).toArray();
}

export async function getAccount(scope: Scope, id: string): Promise<AccountDoc> {
  const doc = await accounts().findOne({ ...owned(scope), _id: id });
  if (!doc) throw notFound("That account doesn't exist, or isn't yours.");
  return doc;
}

export async function createAccount(scope: Scope, body: Record<string, unknown>) {
  const doc: AccountDoc = {
    _id: newId(),
    user_id: scope.userId,
    provider: asProviderId(body.provider ?? "supabase"),
    email: requireString(body.email, "email"),
    label: optionalString(body.label),
    login_method: optionalString(body.login_method),
    notes: optionalString(body.notes),
    last_synced_at: null,
    last_sync_status: null,
    last_sync_error: null,
    created_at: new Date(),
  };

  // A duplicate (user, provider, email) surfaces as a 409 through the index — see the
  // translation in src/http/errors.ts.
  await accounts().insertOne(doc);
  return toAccount(doc);
}

export async function updateAccount(scope: Scope, id: string, body: Record<string, unknown>) {
  const existing = await getAccount(scope, id);

  const patch: Partial<AccountDoc> = {};
  if (body.provider !== undefined) patch.provider = asProviderId(body.provider);
  if (body.email !== undefined) patch.email = requireString(body.email, "email");
  if (body.label !== undefined) patch.label = optionalString(body.label);
  if (body.login_method !== undefined) patch.login_method = optionalString(body.login_method);
  if (body.notes !== undefined) patch.notes = optionalString(body.notes);

  if (Object.keys(patch).length === 0) return toAccount(existing);

  const updated = await accounts().findOneAndUpdate(
    { ...owned(scope), _id: id },
    { $set: patch },
    { returnDocument: "after" },
  );
  if (!updated) throw notFound("That account doesn't exist, or isn't yours.");
  return toAccount(updated);
}

/**
 * Delete an account, reproducing what the foreign keys did.
 *
 * The SQL schema had two different behaviours here and the difference is deliberate:
 * `projects.account_id` is `on delete set null`, so a project outlives the account it was
 * filed under — losing an account record should never silently remove the projects you were
 * tracking with it. `secrets.account_id` is `on delete cascade`, because an account's
 * credentials are meaningless without the account and leaving them would be keeping
 * ciphertext nobody can use or audit.
 *
 * **On ordering, and the absence of a transaction.** MongoDB has multi-document transactions,
 * but only on a replica set — a plain `mongod` on a laptop can't start one, and requiring a
 * replica set to delete an account would be a strange tax on running this locally. So the
 * steps are ordered to make a partial failure recoverable instead: children first, parent
 * last. Crash after step one and the account is still there to retry. Delete the account
 * first and a crash would leave credentials belonging to nothing, invisible to the UI and
 * still in the database. Recoverable beats atomic when atomic costs the ability to run at all.
 */
export async function deleteAccount(scope: Scope, id: string): Promise<void> {
  await getAccount(scope, id);

  await secrets().deleteMany({ ...owned(scope), account_id: id });
  await projects().updateMany({ ...owned(scope), account_id: id }, { $set: { account_id: null } });
  await accounts().deleteOne({ ...owned(scope), _id: id });
}

/** Record the outcome of a discovery sync on the account it ran for. */
export async function recordSyncSuccess(scope: Scope, accountId: string): Promise<void> {
  await accounts().updateOne(
    { ...owned(scope), _id: accountId },
    {
      $set: {
        last_synced_at: new Date(),
        last_sync_status: "ok",
        last_sync_error: null,
      },
    },
  );
}

export async function recordSyncFailure(
  scope: Scope,
  accountId: string,
  message: string,
): Promise<void> {
  await accounts().updateOne(
    { ...owned(scope), _id: accountId },
    {
      $set: {
        last_synced_at: new Date(),
        last_sync_status: "error",
        last_sync_error: message.slice(0, 500),
      },
    },
  );
}

/** Slots used per account, for the free-tier counters. */
export function slotsUsed(list: { account_id: string | null }[]): Record<string, number> {
  const used: Record<string, number> = {};
  for (const p of list) {
    if (p.account_id) used[p.account_id] = (used[p.account_id] ?? 0) + 1;
  }
  return used;
}
