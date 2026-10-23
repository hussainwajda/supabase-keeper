import "server-only";
import { activeProviders, getProvider, isImplemented } from "@/lib/providers/registry";
import type { ProviderId } from "@/lib/providers/types";

/**
 * Which secret kinds exist.
 *
 * A secret's `kind` is the `CredentialField.key` an adapter declared — that is the whole
 * contract, and it means the set of valid kinds grows every time a provider is added. So the
 * authoritative list is computed from the registry rather than typed out by hand.
 *
 * It used to be a hand-maintained array in `app/vault/actions.ts`, and that array fell behind
 * the adapters: MongoDB Atlas declares `sa_client_id` and `sa_client_secret`, neither of which
 * was on it, so saving an Atlas service account failed with "Unknown secret type." — which
 * made Atlas discovery unreachable through the UI. Deriving the list removes the whole class
 * of bug; `lib/providers/__tests__/registry.test.ts` asserts the two can't drift apart again.
 */
export function knownSecretKinds(): Set<string> {
  const kinds = new Set<string>();
  for (const adapter of activeProviders()) {
    for (const field of [...adapter.accountFields, ...adapter.projectFields]) {
      kinds.add(field.key);
    }
  }
  return kinds;
}

export function isKnownSecretKind(kind: string): boolean {
  return knownSecretKinds().has(kind);
}

/**
 * The `server`-tier kinds an adapter can authenticate with, from either owner scope.
 *
 * Same lesson as `knownSecretKinds`, learned a second time. The dashboard's "missing
 * credentials" badge used to ask whether a project had an `anon_key` — a Supabase-only kind —
 * so an Atlas project with a working `connection_string` was reported as having no
 * credentials while the sweep was pinging it successfully every night. The question the badge
 * is really asking is "can the unattended sweep authenticate for this project", and only the
 * adapter knows which kinds answer that.
 *
 * `personal`-tier fields are excluded deliberately: `resolveServerCredentials` skips them, so
 * a project holding nothing but a PIN-encrypted `db_password` genuinely has nothing the sweep
 * can use, and saying otherwise would make the badge lie in the opposite direction.
 */
export function serverCredentialKinds(provider: string): Set<string> {
  if (!isImplemented(provider as ProviderId)) return new Set();
  const adapter = getProvider(provider as ProviderId);
  return new Set(
    [...adapter.accountFields, ...adapter.projectFields]
      .filter((field) => field.tier === "server")
      .map((field) => field.key),
  );
}
