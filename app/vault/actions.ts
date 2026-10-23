"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/backend/user";
import {
  changePin,
  disableRecovery,
  initializeVault,
  lockAllSessions,
  lockVault,
  openVaultSession,
  unwrapWithMaster,
  unwrapWithPin,
  vaultStatus,
  PIN_PATTERN,
} from "@/lib/vault";
import { deleteSecret, putSecret, revealSecret, type SecretKind } from "@/lib/vault/secrets";
import { isKnownSecretKind } from "@/lib/vault/kinds";
import { currentDek } from "@/lib/vault/session";
import { sendOtp, verifyOtp } from "@/lib/vault/otp";
import { otpAvailable } from "@/lib/vault/email";
import { migratePlaintextKeys } from "@/lib/vault/migrate-keys";
import { audit } from "@/lib/vault/audit";
import type { SecretTier } from "@/lib/crypto/secrets";
import { usingNodeBackend } from "@/lib/backend/env";
import { ApiError } from "@/lib/backend/client";
import * as api from "@/lib/backend/api";

/**
 * Run an API call and shape the outcome like the Supabase branch does.
 *
 * Every action in this file returns `{error, notice}` so the vault forms can render the
 * message in place. The API already produces the user-facing wording — "Wrong PIN. 4 attempts
 * left before the vault locks", "Too many wrong attempts. Try again in 15 minutes" — because
 * it was ported from these same actions, so there is nothing to re-translate.
 */
async function viaApi(call: () => Promise<{ notice?: string }>): Promise<ActionResult> {
  try {
    const { notice } = await call();
    revalidatePath("/", "layout");
    return { error: null, notice: notice ?? null };
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message, notice: null };
    throw e;
  }
}

async function requireIdentity(): Promise<{ id: string; email: string }> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return { id: user.id, email: user.email ?? "" };
}

export type ActionResult = { error: string | null; notice: string | null };
const fail = (error: string): ActionResult => ({ error, notice: null });
const notify = (notice: string): ActionResult => ({ error: null, notice });
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

// ---------- PIN ----------

export async function setupPin(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const { id } = await requireIdentity();
  const pin = str(fd, "pin");
  const confirm = str(fd, "confirm");

  if (usingNodeBackend()) return viaApi(() => api.setupPin(pin, confirm));

  if (!PIN_PATTERN.test(pin)) return fail("Use 4 to 8 digits.");
  if (pin !== confirm) return fail("The two PINs don't match.");
  // A PIN this guessable undermines the whole KDF, so refuse it outright.
  if (/^(\d)\1+$/.test(pin)) return fail("That PIN is a single repeated digit. Choose another.");
  if ("0123456789".includes(pin) || "9876543210".includes(pin)) {
    return fail("That PIN is a run of consecutive digits. Choose another.");
  }

  try {
    await initializeVault(id, pin);
  } catch (e) {
    return fail((e as Error).message);
  }

  revalidatePath("/vault");
  return notify("Vault PIN set. Keep it somewhere you won't lose it.");
}

export async function updatePin(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const { id } = await requireIdentity();
  const pin = str(fd, "pin");
  const confirm = str(fd, "confirm");

  if (usingNodeBackend()) return viaApi(() => api.changePin(pin, confirm));

  if (!PIN_PATTERN.test(pin)) return fail("Use 4 to 8 digits.");
  if (pin !== confirm) return fail("The two PINs don't match.");

  // Changing the PIN re-wraps the existing DEK, so it needs the vault open — otherwise we'd
  // have no key to re-wrap and every stored secret would be orphaned.
  const dek = await currentDek(id);
  if (!dek) return fail("Unlock the vault first, then change the PIN.");

  try {
    await changePin(id, dek, pin);
  } catch (e) {
    return fail((e as Error).message);
  }

  revalidatePath("/vault");
  return notify("PIN changed. Your stored secrets are unaffected.");
}

// ---------- unlock ----------

export async function unlockWithPin(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const { id } = await requireIdentity();
  const pin = str(fd, "pin");
  if (!pin) return fail("Enter your PIN.");

  if (usingNodeBackend()) return viaApi(() => api.unlockWithPin(pin));

  const result = await unwrapWithPin(id, pin);

  if (!result.ok) {
    if (result.reason === "no_vault") return fail("Set up a vault PIN first.");
    if (result.reason === "locked") {
      const minutes = Math.ceil((result.lockedMs ?? 0) / 60_000);
      return fail(`Too many wrong attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or unlock with an email code.`);
    }
    const left = result.retriesLeft ?? 0;
    return fail(
      left > 0
        ? `Wrong PIN. ${left} attempt${left === 1 ? "" : "s"} left before the vault locks.`
        : "Wrong PIN. The vault is now locked.",
    );
  }

  await openVaultSession(id, result.dek, "pin");
  revalidatePath("/", "layout");
  return notify("Vault unlocked for 10 minutes.");
}

export async function requestOtp(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const { id, email } = await requireIdentity();
  if (!otpAvailable()) {
    return fail("Email codes aren't configured on this deployment. Use your PIN.");
  }
  if (!email) return fail("Your account has no email address to send a code to.");

  const purpose = str(fd, "purpose") === "pin_reset" ? "pin_reset" : "vault_unlock";

  if (usingNodeBackend()) return viaApi(() => api.requestOtp(purpose));

  const sent = await sendOtp(id, email, purpose);
  if (!sent.ok) return fail(sent.reason);

  return notify(`Code sent to ${email}. It expires in 10 minutes.`);
}

export async function unlockWithOtp(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const { id } = await requireIdentity();
  const code = str(fd, "code");
  if (!code) return fail("Enter the code from your email.");

  if (usingNodeBackend()) return viaApi(() => api.unlockWithOtp(code));

  const verified = await verifyOtp(id, "vault_unlock", code);
  if (!verified.ok) {
    switch (verified.reason) {
      case "no_challenge":
        return fail("No code is outstanding. Request a new one.");
      case "expired":
        return fail("That code has expired. Request a new one.");
      case "too_many":
        return fail("Too many wrong codes. Request a new one.");
      default:
        return fail(
          `Wrong code. ${verified.retriesLeft ?? 0} attempt${verified.retriesLeft === 1 ? "" : "s"} left.`,
        );
    }
  }

  const dek = await unwrapWithMaster(id);
  if (!dek) {
    return fail(
      "Email recovery is switched off for this account, so the code can't unlock the vault. Use your PIN.",
    );
  }

  await openVaultSession(id, dek, "otp");
  revalidatePath("/", "layout");
  return notify("Vault unlocked for 10 minutes.");
}

/** Reset a forgotten PIN: verify an emailed code, then re-wrap the existing DEK. */
export async function resetPinWithOtp(
  _: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const { id } = await requireIdentity();
  const code = str(fd, "code");
  const pin = str(fd, "pin");
  const confirm = str(fd, "confirm");

  if (usingNodeBackend()) return viaApi(() => api.resetPin(code, pin, confirm));

  if (!PIN_PATTERN.test(pin)) return fail("Use 4 to 8 digits.");
  if (pin !== confirm) return fail("The two PINs don't match.");

  const verified = await verifyOtp(id, "pin_reset", code);
  if (!verified.ok) return fail("That code isn't valid. Request a new one.");

  const dek = await unwrapWithMaster(id);
  if (!dek) {
    return fail(
      "Email recovery is switched off for this account, so a forgotten PIN can't be reset. This was the trade-off of turning recovery off.",
    );
  }

  await changePin(id, dek, pin);
  await audit(id, { action: "vault.pin_reset", method: "otp" });
  await openVaultSession(id, dek, "otp");

  revalidatePath("/", "layout");
  return notify("PIN reset, and the vault is unlocked for 10 minutes.");
}

export async function lockNow() {
  const { id } = await requireIdentity();
  if (usingNodeBackend()) {
    await api.lockVault();
    revalidatePath("/", "layout");
    return;
  }
  await lockVault(id);
  revalidatePath("/", "layout");
}

export async function lockEverywhere() {
  const { id } = await requireIdentity();
  if (usingNodeBackend()) {
    await api.lockAllVaultSessions();
    revalidatePath("/", "layout");
    return;
  }
  await lockAllSessions(id);
  revalidatePath("/", "layout");
}

// ---------- recovery ----------

export async function turnOffRecovery(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const { id } = await requireIdentity();

  // Typed confirmation, because this is irreversible and the consequence is total loss.
  // Checked here *and* at the API, which re-checks it for the same reason the Supabase branch
  // re-checks things the UI already validated: a hidden control is not a control.
  if (str(fd, "confirm") !== "no recovery") {
    return fail('Type "no recovery" exactly to confirm.');
  }

  if (usingNodeBackend()) return viaApi(() => api.disableRecovery(str(fd, "confirm")));

  const status = await vaultStatus(id);
  if (!status.initialized) return fail("Set up a vault PIN first.");
  if (!status.recoveryEnabled) return notify("Email recovery is already off.");

  const dek = await currentDek(id);
  if (!dek) return fail("Unlock the vault first.");

  await disableRecovery(id);
  revalidatePath("/vault");
  return notify(
    "Email recovery is off. Your PIN is now the only way to read your personal secrets — nobody can recover them for you.",
  );
}

// ---------- secrets ----------

export async function saveSecret(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const { id } = await requireIdentity();

  // Valid kinds come from the adapters themselves, so a new provider's credentials are
  // storable the moment its adapter declares them. A hand-written list here fell behind the
  // adapters once already and made Atlas service accounts unsaveable.
  const kind = str(fd, "kind") as SecretKind;
  if (!isKnownSecretKind(kind)) {
    return fail(`No provider asks for a "${kind}" credential, so there's nowhere to use it.`);
  }

  const tier: SecretTier = str(fd, "tier") === "server" ? "server" : "personal";
  const value = String(fd.get("value") ?? "");
  if (!value.trim()) return fail("Nothing to store.");

  const accountId = str(fd, "account_id") || null;
  const projectId = str(fd, "project_id") || null;
  if (!accountId && !projectId) return fail("A secret must belong to an account or a project.");

  if (usingNodeBackend()) {
    return viaApi(() =>
      api.putSecret({
        kind,
        tier,
        value,
        label: str(fd, "label") || null,
        account_id: accountId,
        project_id: projectId,
      }),
    );
  }

  try {
    await putSecret(id, { accountId, projectId }, kind, tier, value, str(fd, "label") || null);
  } catch (e) {
    return fail((e as Error).message);
  }

  revalidatePath("/", "layout");
  return notify("Saved, encrypted.");
}

export type RevealState = { value: string | null; error: string | null; secretId: string | null };

export async function reveal(_: RevealState | null, fd: FormData): Promise<RevealState> {
  const { id } = await requireIdentity();
  const secretId = str(fd, "secret_id");
  if (!secretId) return { value: null, error: "No secret specified.", secretId: null };

  if (usingNodeBackend()) {
    try {
      const { value } = await api.revealSecret(secretId);
      return { value, error: null, secretId };
    } catch (e) {
      if (e instanceof ApiError) return { value: null, error: e.message, secretId };
      throw e;
    }
  }

  const result = await revealSecret(id, secretId, null);
  if (result.ok) return { value: result.value, error: null, secretId };

  const message = {
    locked: "Your vault is locked. Unlock it to reveal this.",
    not_found: "That secret no longer exists.",
    undecryptable:
      "This value can't be decrypted with the current keys. If KEEPSTACK_MASTER_KEY changed, restore the old one or re-enter the secret.",
  }[result.reason];

  return { value: null, error: message, secretId };
}

export async function removeSecret(fd: FormData) {
  const { id } = await requireIdentity();
  if (usingNodeBackend()) {
    await api.deleteSecret(str(fd, "secret_id"));
    revalidatePath("/", "layout");
    return;
  }
  await deleteSecret(id, str(fd, "secret_id"));
  revalidatePath("/", "layout");
}

// ---------- one-time key migration ----------

export async function encryptSavedKeys(): Promise<void> {
  const { id } = await requireIdentity();

  if (usingNodeBackend()) {
    // Nothing to do: the Node backend never stored a plaintext key, and any that existed in a
    // migrated Supabase registry were encrypted by the migration script.
    throw new Error("There are no plaintext keys to encrypt on the Node backend.");
  }

  // A PIN first. Without one there is no vault session to open, and reveal is gated on a
  // session — so migrating now would produce secrets the owner could never read back.
  const status = await vaultStatus(id);
  if (!status.initialized) {
    throw new Error("Set a vault PIN first, then encrypt your saved keys.");
  }

  await migratePlaintextKeys(id);
  revalidatePath("/", "layout");
}
