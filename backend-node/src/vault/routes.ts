import { Router } from "express";
import { auth, requireUser, scope } from "../auth/middleware";
import { vaultConfigured, vaultEnvProblems } from "../crypto/env";
import { badRequest, notFound, tooManyRequests, unauthorized, vaultLocked } from "../http/errors";
import { handler, param, requestOrigin } from "../http/handler";
import { listAudit } from "./audit";
import { otpAvailable, otpTransport } from "./email";
import { isKnownSecretKind } from "./kinds";
import {
  changePin,
  disableRecovery,
  initializeVault,
  PIN_PATTERN,
  unwrapWithMaster,
  unwrapWithPin,
  vaultStatus,
} from "./pin";
import { sendOtp, verifyOtp } from "./otp";
import { deleteSecret, listSecrets, putSecret, revealSecret } from "./secrets";
import {
  currentDek,
  lockAllSessions,
  lockVault,
  listVaultSessions,
  openVaultSession,
  vaultSessionRemaining,
} from "./session";
import { asTier } from "../db/validate";

export const vaultRoutes = Router();

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Everything the vault UI needs to render itself in one call: whether a PIN exists, whether
 * the vault is currently unlocked and for how long, whether email recovery is on, and whether
 * this deployment can send codes at all.
 */
vaultRoutes.get(
  "/status",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);
    const [status, remaining] = await Promise.all([
      vaultStatus(user._id),
      vaultSessionRemaining(user._id, req),
    ]);

    res.json({
      ...status,
      unlocked: remaining > 0,
      remaining_seconds: remaining,
      otp_available: otpAvailable(),
      otp_transport: otpTransport(),
      // Surfaced rather than thrown: a misconfigured key should produce an explanation in the
      // UI, not a 500 on every vault page load.
      configured: vaultConfigured(),
      problems: vaultEnvProblems(),
    });
  }),
);

// ─── PIN ──────────────────────────────────────────────────────────────────────

/**
 * First-time PIN setup.
 *
 * The three refusals below are the ones `setupPin` makes, and they matter more here than they
 * look: a 6-digit PIN has about 20 bits of entropy to begin with, and `111111` or `123456`
 * reduces that to nothing. The scrypt cost in `src/crypto/dek.ts` is what makes a brute-force
 * expensive; it can't help with a PIN that's first on every list.
 */
vaultRoutes.post(
  "/pin",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);
    const pin = str(req.body?.pin);
    const confirm = str(req.body?.confirm);

    if (!PIN_PATTERN.test(pin)) throw badRequest("Use 4 to 8 digits.");
    if (pin !== confirm) throw badRequest("The two PINs don't match.");
    if (/^(\d)\1+$/.test(pin)) {
      throw badRequest("That PIN is a single repeated digit. Choose another.");
    }
    if ("0123456789".includes(pin) || "9876543210".includes(pin)) {
      throw badRequest("That PIN is a run of consecutive digits. Choose another.");
    }

    await initializeVault(user._id, pin, requestOrigin(req));
    res.status(201).json({ notice: "Vault PIN set. Keep it somewhere you won't lose it." });
  }),
);

/** Change the PIN. Needs the vault open, because it re-wraps the *existing* DEK. */
vaultRoutes.patch(
  "/pin",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);
    const pin = str(req.body?.pin);
    const confirm = str(req.body?.confirm);

    if (!PIN_PATTERN.test(pin)) throw badRequest("Use 4 to 8 digits.");
    if (pin !== confirm) throw badRequest("The two PINs don't match.");

    // Without an open vault there is no key to re-wrap, and minting a new one would orphan
    // every secret already stored.
    const dek = await currentDek(user._id, req);
    if (!dek) throw vaultLocked("Unlock the vault first, then change the PIN.");

    await changePin(user._id, dek, pin, requestOrigin(req));
    res.json({ notice: "PIN changed. Your stored secrets are unaffected." });
  }),
);

/** Reset a forgotten PIN: verify an emailed code, then re-wrap the existing DEK. */
vaultRoutes.post(
  "/pin/reset",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);
    const code = str(req.body?.code);
    const pin = str(req.body?.pin);
    const confirm = str(req.body?.confirm);

    if (!PIN_PATTERN.test(pin)) throw badRequest("Use 4 to 8 digits.");
    if (pin !== confirm) throw badRequest("The two PINs don't match.");

    const verified = await verifyOtp(user._id, "pin_reset", code, requestOrigin(req));
    if (!verified.ok) throw badRequest("That code isn't valid. Request a new one.");

    const dek = await unwrapWithMaster(user._id);
    if (!dek) {
      throw badRequest(
        "Email recovery is switched off for this account, so a forgotten PIN can't be reset. This was the trade-off of turning recovery off.",
      );
    }

    await changePin(user._id, dek, pin, requestOrigin(req));
    await openVaultSession(user._id, dek, "otp", req, res);
    res.json({ notice: "PIN reset, and the vault is unlocked for 10 minutes." });
  }),
);

// ─── unlock ───────────────────────────────────────────────────────────────────

vaultRoutes.post(
  "/unlock/pin",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);
    const pin = str(req.body?.pin);
    if (!pin) throw badRequest("Enter your PIN.");

    const result = await unwrapWithPin(user._id, pin, requestOrigin(req));

    if (!result.ok) {
      if (result.reason === "no_vault") throw badRequest("Set up a vault PIN first.");
      if (result.reason === "locked") {
        const minutes = Math.ceil((result.lockedMs ?? 0) / 60_000);
        throw tooManyRequests(
          `Too many wrong attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or unlock with an email code.`,
          { locked_ms: result.lockedMs ?? 0 },
        );
      }
      const left = result.retriesLeft ?? 0;
      throw unauthorized(
        left > 0
          ? `Wrong PIN. ${left} attempt${left === 1 ? "" : "s"} left before the vault locks.`
          : "Wrong PIN. The vault is now locked.",
      );
    }

    await openVaultSession(user._id, result.dek, "pin", req, res);
    res.json({ notice: "Vault unlocked for 10 minutes." });
  }),
);

vaultRoutes.post(
  "/otp",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);
    if (!otpAvailable()) {
      throw badRequest("Email codes aren't configured on this deployment. Use your PIN.");
    }
    if (!user.email) throw badRequest("Your account has no email address to send a code to.");

    const purpose = str(req.body?.purpose) === "pin_reset" ? "pin_reset" : "vault_unlock";
    const sent = await sendOtp(user._id, user.email, purpose, requestOrigin(req));
    if (!sent.ok) {
      throw sent.retryAfter
        ? tooManyRequests(sent.reason, { retry_after: sent.retryAfter })
        : badRequest(sent.reason);
    }

    res.json({ notice: `Code sent to ${user.email}. It expires in 10 minutes.` });
  }),
);

vaultRoutes.post(
  "/unlock/otp",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);
    const code = str(req.body?.code);
    if (!code) throw badRequest("Enter the code from your email.");

    const verified = await verifyOtp(user._id, "vault_unlock", code, requestOrigin(req));
    if (!verified.ok) {
      const message = {
        no_challenge: "No code is outstanding. Request a new one.",
        expired: "That code has expired. Request a new one.",
        too_many: "Too many wrong codes. Request a new one.",
        wrong_code: `Wrong code. ${verified.retriesLeft ?? 0} attempt${verified.retriesLeft === 1 ? "" : "s"} left.`,
      }[verified.reason];
      throw unauthorized(message);
    }

    const dek = await unwrapWithMaster(user._id);
    if (!dek) {
      throw badRequest(
        "Email recovery is switched off for this account, so the code can't unlock the vault. Use your PIN.",
      );
    }

    await openVaultSession(user._id, dek, "otp", req, res);
    res.json({ notice: "Vault unlocked for 10 minutes." });
  }),
);

vaultRoutes.post(
  "/lock",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);
    await lockVault(user._id, req, res);
    res.json({ ok: true });
  }),
);

vaultRoutes.post(
  "/lock-all",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);
    await lockAllSessions(user._id, req, res);
    res.json({ ok: true });
  }),
);

vaultRoutes.get(
  "/sessions",
  requireUser,
  handler(async (req, res) => {
    res.json({ sessions: await listVaultSessions(auth(req).user._id) });
  }),
);

// ─── recovery ─────────────────────────────────────────────────────────────────

/**
 * Delete the recovery copy of the DEK.
 *
 * Irreversible, and the consequence is total loss of personal secrets if the PIN is
 * forgotten — so it asks for a typed phrase and for the vault to be open, which together make
 * it hard to do by accident or by a forged request.
 */
vaultRoutes.delete(
  "/recovery",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);

    if (str(req.body?.confirm) !== "no recovery") {
      throw badRequest('Type "no recovery" exactly to confirm.');
    }

    const status = await vaultStatus(user._id);
    if (!status.initialized) throw badRequest("Set up a vault PIN first.");
    if (!status.recoveryEnabled) {
      res.json({ notice: "Email recovery is already off." });
      return;
    }

    const dek = await currentDek(user._id, req);
    if (!dek) throw vaultLocked("Unlock the vault first.");

    await disableRecovery(user._id, requestOrigin(req));
    res.json({
      notice:
        "Email recovery is off. Your PIN is now the only way to read your personal secrets — nobody can recover them for you.",
    });
  }),
);

// ─── secrets ──────────────────────────────────────────────────────────────────

vaultRoutes.get(
  "/secrets",
  requireUser,
  handler(async (req, res) => {
    const accountId = typeof req.query.account_id === "string" ? req.query.account_id : null;
    const projectId = typeof req.query.project_id === "string" ? req.query.project_id : null;
    res.json({ secrets: await listSecrets(scope(req), { accountId, projectId }) });
  }),
);

vaultRoutes.post(
  "/secrets",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);

    /*
     * Valid kinds come from the adapters themselves, so a new provider's credentials are
     * storable the moment its adapter declares them. A hand-written list here fell behind the
     * adapters once already and made Atlas service accounts unsaveable — see the note in
     * src/vault/kinds.ts.
     */
    const kind = str(req.body?.kind);
    if (!isKnownSecretKind(kind)) {
      throw badRequest(`No provider asks for a "${kind}" credential, so there's nowhere to use it.`);
    }

    const tier = asTier(req.body?.tier, "personal");
    const value = typeof req.body?.value === "string" ? req.body.value : "";
    if (!value.trim()) throw badRequest("Nothing to store.");

    const accountId = str(req.body?.account_id) || null;
    const projectId = str(req.body?.project_id) || null;
    if (!accountId && !projectId) {
      throw badRequest("A secret must belong to an account or a project.");
    }

    const id = await putSecret({
      scope: scope(req),
      owner: { accountId, projectId },
      kind,
      tier,
      value,
      label: str(req.body?.label) || null,
      // Only read for a personal write; a server write ignores it.
      dek: tier === "personal" ? await currentDek(user._id, req) : null,
      origin: requestOrigin(req),
    });

    res.status(201).json({ id, notice: "Saved, encrypted." });
  }),
);

vaultRoutes.post(
  "/secrets/:id/reveal",
  requireUser,
  handler(async (req, res) => {
    const { user } = auth(req);
    const dek = await currentDek(user._id, req);

    const result = await revealSecret(
      scope(req),
      param(req, "id"),
      dek,
      null,
      requestOrigin(req),
    );

    if (result.ok) {
      // Never cached, anywhere. This is the one response in the API that carries a plaintext
      // credential, and a proxy or browser keeping a copy of it would undo the whole vault.
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.json({ value: result.value });
      return;
    }

    const message = {
      locked: "Your vault is locked. Unlock it to reveal this.",
      not_found: "That secret no longer exists.",
      undecryptable:
        "This value can't be decrypted with the current keys. If KEEPSTACK_MASTER_KEY changed, restore the old one or re-enter the secret.",
    }[result.reason];

    throw result.reason === "locked" ? vaultLocked(message) : badRequest(message);
  }),
);

vaultRoutes.delete(
  "/secrets/:id",
  requireUser,
  handler(async (req, res) => {
    // `deleteSecret` is scoped, so a secret belonging to someone else reports `false` exactly
    // as a deleted one does — which is the property worth keeping. Turning that into the same
    // 404 the rest of the API uses means a caller can't tell the two apart either.
    const removed = await deleteSecret(scope(req), param(req, "id"), requestOrigin(req));
    if (!removed) throw notFound("That secret doesn't exist, or isn't yours.");
    res.json({ ok: true });
  }),
);

// ─── audit ────────────────────────────────────────────────────────────────────

vaultRoutes.get(
  "/audit",
  requireUser,
  handler(async (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    res.json({ entries: await listAudit(scope(req), limit) });
  }),
);
