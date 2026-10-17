import "server-only";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { supabaseService } from "@/lib/supabase/service";
import { audit } from "./audit";
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
): Promise<SendResult> {
  const db = supabaseService();

  const { data: recent } = await db
    .from("otp_challenges")
    .select("created_at")
    .eq("user_id", userId)
    .eq("purpose", purpose)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recent) {
    const age = (Date.now() - new Date(recent.created_at as string).getTime()) / 1000;
    if (age < RESEND_COOLDOWN_SECONDS) {
      return {
        ok: false,
        reason: "A code was just sent. Check your inbox.",
        retryAfter: Math.ceil(RESEND_COOLDOWN_SECONDS - age),
      };
    }
  }

  await db.from("otp_challenges").delete().eq("user_id", userId).eq("purpose", purpose);

  const code = generateCode();
  const { error } = await db.from("otp_challenges").insert({
    user_id: userId,
    code_hash: hashCode(code),
    purpose,
    expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString(),
  });
  if (error) throw error;

  try {
    await sendOtpEmail(email, code);
  } catch (e) {
    // Don't leave a live challenge behind for a code nobody received.
    await db.from("otp_challenges").delete().eq("user_id", userId).eq("purpose", purpose);
    return { ok: false, reason: (e as Error).message };
  }

  await audit(userId, { action: "vault.otp_sent", method: "otp", detail: { purpose } });
  return { ok: true };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "no_challenge" | "expired" | "too_many" | "wrong_code"; retriesLeft?: number };

/**
 * Verify and consume a code. Single use: a successful verify marks the challenge consumed, so
 * replaying the same code does nothing.
 */
export async function verifyOtp(
  userId: string,
  purpose: OtpPurpose,
  code: string,
): Promise<VerifyResult> {
  const db = supabaseService();

  const { data } = await db
    .from("otp_challenges")
    .select("id, code_hash, attempts, expires_at, consumed_at")
    .eq("user_id", userId)
    .eq("purpose", purpose)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return { ok: false, reason: "no_challenge" };

  if (new Date(data.expires_at as string) <= new Date()) {
    await db.from("otp_challenges").delete().eq("id", data.id);
    return { ok: false, reason: "expired" };
  }

  const attempts = (data.attempts as number) ?? 0;
  if (attempts >= MAX_OTP_ATTEMPTS) {
    await db.from("otp_challenges").delete().eq("id", data.id);
    return { ok: false, reason: "too_many" };
  }

  const expected = Buffer.from(data.code_hash as string, "base64");
  const actual = Buffer.from(hashCode(code.trim()), "base64");
  const matches = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!matches) {
    await db.from("otp_challenges").update({ attempts: attempts + 1 }).eq("id", data.id);
    await audit(userId, {
      action: "vault.unlock_failed",
      method: "otp",
      detail: { purpose, attempts: attempts + 1 },
    });
    return { ok: false, reason: "wrong_code", retriesLeft: MAX_OTP_ATTEMPTS - (attempts + 1) };
  }

  await db
    .from("otp_challenges")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", data.id);
  return { ok: true };
}
