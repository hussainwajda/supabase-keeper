import { randomUUID } from "node:crypto";

/**
 * Primary keys are UUID strings, matching `gen_random_uuid()` in the SQL schema rather than
 * MongoDB's ObjectId.
 *
 * Not a style choice. The migration has to carry the existing keys across unchanged, because
 * a user's id is baked into the AAD of every secret they own and of both wrapped copies of
 * their DEK (`src/crypto/secrets.ts`, `src/crypto/dek.ts`). Reissuing ids would silently turn
 * every stored credential into undecryptable noise. Since the migrated documents must hold
 * UUIDs, new documents use them too — a collection with ObjectIds for some rows and UUID
 * strings for others is a sorting and equality trap waiting to happen.
 */
export const newId = (): string => randomUUID();
