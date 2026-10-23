import type { Filter } from "mongodb";
import { secrets } from "../db/collections";
import type { SecretDoc } from "../db/documents";
import { newId } from "../db/ids";
import { owned, type Scope } from "../db/scope";
import {
  openPersonalSecret,
  openServerSecret,
  sealPersonalSecret,
  sealServerSecret,
  type SecretTier,
} from "../crypto/secrets";
import { assertVaultEnv } from "../crypto/env";
import { badRequest, vaultLocked } from "../http/errors";
import { toSecretSummary } from "../http/serialize";
import { serverCredentialKinds } from "./kinds";
import { audit, type RequestOrigin } from "./audit";

/**
 * A secret's kind is the `CredentialField.key` its adapter declared, so this is an open set:
 * every provider added may introduce new kinds. The literals below are the ones in use today
 * and exist for autocompletion; `(string & {})` keeps that while still accepting a kind a
 * newer adapter declares. The authoritative runtime check is `isKnownSecretKind`, which asks
 * the registry — see `src/vault/kinds.ts` for why that matters.
 */
export type SecretKind =
  | "account_password"
  | "pat"
  | "api_key"
  | "api_email"
  | "sa_client_id"
  | "sa_client_secret"
  | "db_password"
  | "anon_key"
  | "connection_string"
  | "rest_token"
  | (string & {});

export type SecretOwner = { accountId?: string | null; projectId?: string | null };

/**
 * Narrow a filter to one owner.
 *
 * The polymorphic owner is the same design as the SQL schema — a secret belongs to an account
 * *or* a project — so the same invariant has to hold: exactly one of them, never neither.
 * Throwing on neither is what stops a query from quietly widening to every secret the user
 * owns, which is the shape of mistake that turns "show this project's credentials" into
 * "show all of them".
 */
function ownerFilter(owner: SecretOwner): Filter<SecretDoc> {
  if (owner.projectId) return { project_id: owner.projectId };
  if (owner.accountId) return { account_id: owner.accountId };
  throw badRequest("A secret must belong to either an account or a project.");
}

/**
 * List secrets for the inventory UI.
 *
 * `toSecretSummary` is what keeps `ciphertext` out of the response — there is no projection
 * to forget, because the serialiser names the fields it emits. docs/SECURITY.md §6 forbids
 * `select *` on this table for exactly this reason.
 */
export async function listSecrets(scope: Scope, owner?: SecretOwner) {
  const filter: Filter<SecretDoc> = owned(scope);
  if (owner?.projectId) filter.project_id = owner.projectId;
  if (owner?.accountId) filter.account_id = owner.accountId;

  const docs = await secrets().find(filter).sort({ created_at: 1 }).toArray();
  return docs.map(toSecretSummary);
}

export type PutSecretInput = {
  scope: Scope;
  owner: SecretOwner;
  kind: SecretKind;
  tier: SecretTier;
  value: string;
  label?: string | null;
  /**
   * The user's unwrapped DEK. Required for a `personal` write and ignored for a `server` one —
   * which is the tier boundary expressed in the signature rather than in a comment.
   */
  dek?: Buffer | null;
  origin?: RequestOrigin;
};

/**
 * Store a secret, encrypting it according to its tier.
 *
 * A `personal` secret needs a live vault session, because its key is the user's DEK — which
 * the server only ever holds during an unlocked request. A `server` secret does not, because
 * the nightly sweep has to be able to read it unattended.
 */
export async function putSecret(input: PutSecretInput): Promise<string> {
  assertVaultEnv();
  const { scope, owner, kind, tier, label, origin } = input;
  if (!input.value.trim()) throw badRequest("Nothing to store.");

  let ciphertext: string;
  if (tier === "server") {
    ciphertext = sealServerSecret(input.value, scope.userId, kind);
  } else {
    if (!input.dek) {
      throw vaultLocked("Your vault is locked. Unlock it before saving a personal secret.");
    }
    ciphertext = sealPersonalSecret(input.value, input.dek, scope.userId, kind);
  }

  const now = new Date();

  /*
   * One document per (owner, kind), so "update the PAT" is unambiguous. Expressed as an
   * upsert on the owner filter rather than the select-then-insert-or-update the Supabase
   * version does: that version has a race where two concurrent saves both find nothing and
   * both insert, and only the unique index stops the second one — as a 409 the user then has
   * to make sense of. Here the upsert resolves it in the server, and the index is a backstop
   * rather than the mechanism.
   */
  const result = await secrets().findOneAndUpdate(
    { ...owned(scope), ...ownerFilter(owner), kind },
    {
      $set: { ciphertext, tier, label: label ?? null, updated_at: now },
      $setOnInsert: {
        _id: newId(),
        user_id: scope.userId,
        account_id: owner.accountId ?? null,
        project_id: owner.projectId ?? null,
        kind,
        key_version: 1,
        last_used_at: null,
        last_verified_at: null,
        created_at: now,
      },
    },
    { upsert: true, returnDocument: "after" },
  );

  const id = result?._id ?? "";
  const created = result?.created_at?.getTime() === now.getTime();

  await audit(
    scope.userId,
    {
      action: created ? "secret.create" : "secret.update",
      targetType: "secret",
      targetId: id,
      detail: { kind, tier },
    },
    origin,
  );

  return id;
}

/**
 * Decrypt a `server`-tier secret for unattended use (the sweep, provider discovery).
 *
 * Deliberately refuses `personal` documents: that refusal is the tier boundary in code, not
 * just in the AAD. Returns null rather than throwing so a single missing key doesn't abort a
 * sweep.
 */
export async function readServerSecret(
  scope: Scope,
  owner: SecretOwner,
  kind: SecretKind,
): Promise<string | null> {
  const doc = await secrets().findOne({ ...owned(scope), ...ownerFilter(owner), kind });
  if (!doc || doc.tier !== "server") return null;

  const value = openServerSecret(doc.ciphertext, scope.userId, kind);
  if (value) {
    await secrets().updateOne({ _id: doc._id }, { $set: { last_used_at: new Date() } });
  }
  return value;
}

export type RevealResult =
  | { ok: true; value: string }
  | { ok: false; reason: "locked" | "not_found" | "undecryptable" };

/**
 * Reveal one secret to the signed-in user.
 *
 * Always audited, including the failures. A `null` `dek` means the vault is locked, and both
 * tiers are gated on that: `server` rows are revealable too, because hiding an anon key from
 * its owner would be theatre — but the reveal is still gated on an unlock and still logged.
 */
export async function revealSecret(
  scope: Scope,
  secretId: string,
  dek: Buffer | null,
  method: "pin" | "otp" | null,
  origin?: RequestOrigin,
): Promise<RevealResult> {
  assertVaultEnv();
  if (!dek) return { ok: false, reason: "locked" };

  const doc = await secrets().findOne({ ...owned(scope), _id: secretId });
  if (!doc) return { ok: false, reason: "not_found" };

  const value =
    doc.tier === "server"
      ? openServerSecret(doc.ciphertext, scope.userId, doc.kind)
      : openPersonalSecret(doc.ciphertext, dek, scope.userId, doc.kind);

  if (value === null) {
    await audit(
      scope.userId,
      {
        action: "secret.reveal",
        targetType: "secret",
        targetId: secretId,
        method,
        detail: { kind: doc.kind, tier: doc.tier, outcome: "undecryptable" },
      },
      origin,
    );
    return { ok: false, reason: "undecryptable" };
  }

  await Promise.all([
    secrets().updateOne({ _id: secretId }, { $set: { last_used_at: new Date() } }),
    audit(
      scope.userId,
      {
        action: "secret.reveal",
        targetType: "secret",
        targetId: secretId,
        method,
        // The kind and label say *what* was revealed. The value is never recorded.
        detail: { kind: doc.kind, tier: doc.tier, label: doc.label ?? null },
      },
      origin,
    ),
  ]);

  return { ok: true, value };
}

export async function deleteSecret(
  scope: Scope,
  secretId: string,
  origin?: RequestOrigin,
): Promise<boolean> {
  // Read first so the audit entry can say what was deleted; scoped, so another user's id
  // is indistinguishable from one that doesn't exist.
  const doc = await secrets().findOne({ ...owned(scope), _id: secretId });
  if (!doc) return false;

  await secrets().deleteOne({ ...owned(scope), _id: secretId });
  await audit(
    scope.userId,
    {
      action: "secret.delete",
      targetType: "secret",
      targetId: secretId,
      detail: { kind: doc.kind, tier: doc.tier },
    },
    origin,
  );
  return true;
}

/**
 * Project ids the unattended sweep has usable credentials for.
 *
 * Feeds the dashboard's "missing credentials" warning. In the Supabase app this had to
 * reconcile three states — plaintext column, encrypted secret, or neither — because the
 * plaintext column was being migrated out from under it. Here there was never a plaintext
 * column, so the vault is the only source of truth and the question has one answer.
 *
 * Two things it deliberately does *not* do. It doesn't look for one fixed kind: the kinds
 * that count come from the adapter (`serverCredentialKinds`), because `anon_key` answers the
 * question for Supabase and for nobody else. And it doesn't look only at the project: a
 * Supabase project with no key of its own is still perfectly pingable through its account's
 * `pat`, which is the transport the adapter prefers anyway.
 */
export async function projectIdsWithStoredKey(
  scope: Scope,
  projects: { id: string; provider: string; account_id: string | null }[],
): Promise<Set<string>> {
  if (projects.length === 0) return new Set();

  const docs = await secrets()
    .find({ ...owned(scope), tier: "server" })
    .project<Pick<SecretDoc, "kind" | "account_id" | "project_id">>({
      kind: 1,
      account_id: 1,
      project_id: 1,
    })
    .toArray();

  // One pass over the secrets, then one lookup per project — rather than a query per project.
  const kindsByOwner = new Map<string, Set<string>>();
  for (const doc of docs) {
    for (const owner of [doc.account_id, doc.project_id]) {
      if (!owner) continue;
      const kinds = kindsByOwner.get(owner) ?? new Set<string>();
      kinds.add(doc.kind);
      kindsByOwner.set(owner, kinds);
    }
  }

  const ready = new Set<string>();
  for (const project of projects) {
    const usable = serverCredentialKinds(project.provider);
    if (usable.size === 0) continue;
    const held = [
      ...(kindsByOwner.get(project.id) ?? []),
      ...(project.account_id ? (kindsByOwner.get(project.account_id) ?? []) : []),
    ];
    if (held.some((kind) => usable.has(kind))) ready.add(project.id);
  }
  return ready;
}

/** Delete every secret belonging to an owner — the `on delete cascade` equivalent. */
export async function deleteSecretsFor(scope: Scope, owner: SecretOwner): Promise<number> {
  const { deletedCount } = await secrets().deleteMany({ ...owned(scope), ...ownerFilter(owner) });
  return deletedCount ?? 0;
}
