import "server-only";

/**
 * OTP delivery.
 *
 * Resend is the production path. When no API key is configured the OTP route is disabled in
 * the UI with an explanation — the PIN still works, so the vault is fully usable without it;
 * only the "forgot my PIN" recovery path needs email.
 *
 * In development you can set KEEPSTACK_OTP_DEV_ECHO=true to print codes to the server log
 * instead of sending them. It is double-gated on NODE_ENV so it cannot be switched on in a
 * production deployment by setting one variable.
 */
export function otpTransport(): "resend" | "dev-echo" | "none" {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.NODE_ENV !== "production" && process.env.KEEPSTACK_OTP_DEV_ECHO === "true") {
    return "dev-echo";
  }
  return "none";
}

export function otpAvailable(): boolean {
  return otpTransport() !== "none";
}

function body(code: string): { subject: string; text: string; html: string } {
  const subject = `${code} is your Keepstack vault code`;
  const text = [
    `Your Keepstack vault code is ${code}`,
    "",
    "It expires in 10 minutes and can be used once.",
    "",
    "If you didn't ask to unlock your vault, someone may have your Keepstack password.",
    "Change it, and check the audit log on your Vault page.",
  ].join("\n");

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;color:#171a19">
  <p>Your Keepstack vault code is:</p>
  <p style="font-family:ui-monospace,Menlo,monospace;font-size:30px;font-weight:600;letter-spacing:.14em;margin:20px 0">${code}</p>
  <p style="color:#69716d">It expires in 10 minutes and can be used once.</p>
  <hr style="border:none;border-top:1px solid #e3e6e4;margin:22px 0">
  <p style="color:#69716d;font-size:13px">If you didn't ask to unlock your vault, someone may have your Keepstack password. Change it, then check the audit log on your Vault page.</p>
</div>`;

  return { subject, text, html };
}

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  const transport = otpTransport();
  const { subject, text, html } = body(code);

  if (transport === "dev-echo") {
    console.log(`\n[keepstack:dev] vault OTP for ${to}: ${code}  (expires in 10 minutes)\n`);
    return;
  }

  if (transport === "none") {
    throw new Error(
      "Email codes are not configured. Set RESEND_API_KEY to enable PIN recovery by email.",
    );
  }

  const from = process.env.KEEPSTACK_FROM_EMAIL;
  if (!from) {
    throw new Error(
      "KEEPSTACK_FROM_EMAIL is not set. Use an address on a domain you've verified with Resend.",
    );
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    // Resend echoes the payload in errors, so log only the status and a short reason.
    const reason = (await res.text()).slice(0, 200);
    throw new Error(`Could not send the email (${res.status}). ${reason}`);
  }
}
