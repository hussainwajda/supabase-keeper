import { users } from "../db/collections";
import { newId } from "../db/ids";
import type { UserDoc } from "../db/documents";
import { conflict } from "../http/errors";

/**
 * The users collection.
 *
 * This is `auth.users` and `public.profiles` merged back into one document. They were two
 * tables only because Supabase Auth owned one of them and migration 0003 had to mirror it
 * with a trigger (`handle_new_user`) to keep a profile row in step. Owning identity here
 * means there is nothing to keep in step: the vault fields live on the user.
 */

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export async function findUserById(id: string): Promise<UserDoc | null> {
  return users().findOne({ _id: id });
}

export async function findUserByEmail(email: string): Promise<UserDoc | null> {
  return users().findOne({ email: normalizeEmail(email) });
}

export async function findUserByGoogleSub(sub: string): Promise<UserDoc | null> {
  return users().findOne({ google_sub: sub });
}

export async function countUsers(): Promise<number> {
  return users().countDocuments();
}

export type NewUser = {
  email: string;
  passwordHash?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  googleSub?: string | null;
  /** Set only by the migration, to carry a Supabase user's UUID across unchanged. */
  id?: string;
};

export async function createUser(input: NewUser): Promise<UserDoc> {
  const now = new Date();
  const doc: UserDoc = {
    _id: input.id ?? newId(),
    email: normalizeEmail(input.email),
    password_hash: input.passwordHash ?? null,
    display_name: input.displayName ?? null,
    avatar_url: input.avatarUrl ?? null,
    google_sub: input.googleSub ?? null,
    vault_initialized_at: null,
    pin_salt: null,
    dek_pin: null,
    dek_srv: null,
    pin_failed_attempts: 0,
    pin_locked_until: null,
    created_at: now,
    updated_at: now,
  };

  try {
    await users().insertOne(doc);
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      throw conflict("An account with that email already exists.");
    }
    throw e;
  }
  return doc;
}

export async function patchUser(id: string, patch: Partial<UserDoc>): Promise<void> {
  await users().updateOne({ _id: id }, { $set: { ...patch, updated_at: new Date() } });
}

/** Link a Google identity to an existing local account, matched on a verified email. */
export async function linkGoogle(
  id: string,
  sub: string,
  profile: { displayName?: string | null; avatarUrl?: string | null },
): Promise<void> {
  const patch: Partial<UserDoc> = { google_sub: sub };
  // Only fill gaps — a name the user set here shouldn't be overwritten by their Google one.
  if (profile.displayName) patch.display_name = profile.displayName;
  if (profile.avatarUrl) patch.avatar_url = profile.avatarUrl;
  await patchUser(id, patch);
}
