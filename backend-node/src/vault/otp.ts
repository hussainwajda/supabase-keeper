import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { otpChallenges } from "../db/collections";
import { newId } from "../db/ids";
import { audit, type RequestOrigin } from "./audit";
import { sendOtpEmail } from "./email";

export const OTP_TTL_MINUTES = 10;
export const MAX_OTP_ATTEMPTS = 5;
/** Don't let someone spam a mailbox by holding down a button. */
const RESEND_COOLDOWN_SECONDS = 60;

export type OtpPurpose = "vault_unlock" | "pin_reset";

/** `randomInt` is the CSPRNG path; `Math.random` would be predictable. */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("base64");
}

export type SendResult = { ok: true } | { ok: false; reason: string; retryAfter?: number };

/**
 * Email a fresh code.
 *
 * Issuing a new code invalidates any outstanding one for the same purpose, so an attacker
 * can't keep a pool of valid codes alive by triggering sends.
 */
export async function sendOtp(
  userId: string,
  email: string,
  purpose: OtpPurpose,
  origin?: RequestOrigin,
): Promise<SendResult> {
  const recent = await otpChallenges()
    .find({ user_id: userId, purpose })
    .sort({ created_at: -1 })
    .limit(1)
    .next();

  if (recent) {
    const age = (Date.now() - recent.created_at.getTime()) / 1000;
    if (age < RESEND_COOLDOWN_SECONDS) {
      return {
        ok: false,
        reason: "A code was just sent. Check your inbox.",
        retryAfter: Math.ceil(RESEND_COOLDOWN_SECONDS - age),
      };
    }
  }

  await otpChallenges().deleteMany({ user_id: userId, purpose });

  const code = generateCode();
  await otpChallenges().insertOne({
    _id: newId(),
    user_id: userId,
    code_hash: hashCode(code),
    purpose,
    attempts: 0,
    consumed_at: null,
    expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60_000),
    created_at: new Date(),
  });

  try {
    await sendOtpEmail(email, code);
  } catch (e) {
    // Don't leave a live challenge behind for a code nobody received.
    await otpChallenges().deleteMany({ user_id: userId, purpose });
    return { ok: false, reason: (e as Error).message };
  }

  await audit(userId, { action: "vault.otp_sent", method: "otp", detail: { purpose } }, origin);
  return { ok: true };
}

export type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason: "no_challenge" | "expired" | "too_many" | "wrong_code";
      retriesLeft?: number;
    };

/**
 * Verify and consume a code.
 *
 * Single use: a successful verify marks the challenge consumed, so replaying the same code
 * does nothing. The attempt counter uses `$inc` for the same reason the PIN counter does —
 * codes submitted concurrently must each be counted, or the cap isn't a cap.
 */
export async function verifyOtp(
  userId: string,
  purpose: OtpPurpose,
  code: string,
  origin?: RequestOrigin,
): Promise<VerifyResult> {
  const challenge = await otpChallenges()
    .find({ user_id: userId, purpose, consumed_at: null })
    .sort({ created_at: -1 })
    .limit(1)
    .next();

  if (!challenge) return { ok: false, reason: "no_challenge" };

  if (challenge.expires_at <= new Date()) {
    await otpChallenges().deleteOne({ _id: challenge._id });
    return { ok: false, reason: "expired" };
  }

  if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
    await otpChallenges().deleteOne({ _id: challenge._id });
    return { ok: false, reason: "too_many" };
  }

  const expected = Buffer.from(challenge.code_hash, "base64");
  const actual = Buffer.from(hashCode(code.trim()), "base64");
  const matches = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!matches) {
    const updated = await otpChallenges().findOneAndUpdate(
      { _id: challenge._id },
      { $inc: { attempts: 1 } },
      { returnDocument: "after", projection: { attempts: 1 } },
    );
    const attempts = updated?.attempts ?? challenge.attempts + 1;
    await audit(
      userId,
      { action: "vault.unlock_failed", method: "otp", detail: { purpose, attempts } },
      origin,
    );
    return { ok: false, reason: "wrong_code", retriesLeft: Math.max(0, MAX_OTP_ATTEMPTS - attempts) };
  }

  /*
   * Consume it, and only treat the verification as successful if this update is the one that
   * did so. Filtering on `consumed_at: null` makes the write the race's arbiter: two requests
   * carrying the same correct code both reach here, both try to consume, and exactly one
   * matches. The loser is told the code is spent rather than being handed a second unlock.
   */
  const consumed = await otpChallenges().updateOne(
    { _id: challenge._id, consumed_at: null },
    { $set: { consumed_at: new Date() } },
  );
  if (consumed.modifiedCount !== 1) return { ok: false, reason: "no_challenge" };

  return { ok: true };
}
