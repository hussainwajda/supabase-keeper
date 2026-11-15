import "server-only";

/**
 * OTP delivery.
 *
 * Three transports, chosen by which variables are set:
 *
 *   resend    RESEND_API_KEY — an HTTP API, so it works on any runtime and needs no open
 *             outbound port. Best for a hosted deployment.
 *   smtp      SMTP_HOST + SMTP_USER + SMTP_PASS — any mailbox you already own, including
 *             Gmail with an app password. Requires a Node runtime and outbound TCP.
 *   dev-echo  Prints the code to the server log. Double-gated on NODE_ENV so it cannot be
 *             switched on in a production deployment by setting one variable.
 *
 * Resend wins when both are configured, because an API call fails faster and more clearly
 * than an SMTP handshake. The PIN still works with no transport at all — only the
 * "forgot my PIN" recovery path needs email.
 */
export function otpTransport(): "resend" | "smtp" | "dev-echo" | "none" {
  if (process.env.RESEND_API_KEY) return "resend";
  if (smtpConfigured()) return "smtp";
  if (process.env.NODE_ENV !== "production" && process.env.KEEPSTACK_OTP_DEV_ECHO === "true") {
    return "dev-echo";
  }
  return "none";
}

export function otpAvailable(): boolean {
  return otpTransport() !== "none";
}

function smtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/**
 * Who the mail claims to be from.
 *
 * Under SMTP this defaults to the authenticated mailbox, because most providers — Gmail
 * among them — reject or silently rewrite a From that isn't an address the account owns.
 * Defaulting to it means an app-password setup needs three variables, not four, and the
 * common mistake (a From on a domain you don't control) can't happen by accident.
 */
function fromAddress(transport: "resend" | "smtp"): string {
  const configured = process.env.KEEPSTACK_FROM_EMAIL;
  if (configured) return configured;
  if (transport === "smtp" && process.env.SMTP_USER) return process.env.SMTP_USER;
  throw new Error(
    "KEEPSTACK_FROM_EMAIL is not set. Use an address on a domain you've verified with Resend.",
  );
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
      "Email codes are not configured. Set RESEND_API_KEY, or SMTP_HOST/SMTP_USER/SMTP_PASS, to enable PIN recovery by email.",
    );
  }

  if (transport === "smtp") {
    await sendViaSmtp(to, { subject, text, html });
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: fromAddress("resend"), to: [to], subject, text, html }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    // Resend echoes the payload in errors, so log only the status and a short reason.
    const reason = (await res.text()).slice(0, 200);
    throw new Error(`Could not send the email (${res.status}). ${reason}`);
  }
}

async function sendViaSmtp(
  to: string,
  message: { subject: string; text: string; html: string },
): Promise<void> {
  // Imported lazily so nodemailer — a Node-only library — is never pulled into a bundle for
  // a deployment that uses Resend or no email at all.
  const nodemailer = (await import("nodemailer")).default;

  const port = Number(process.env.SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`SMTP_PORT must be a port number, got "${process.env.SMTP_PORT}".`);
  }

  /*
   * `secure` means "wrap the connection in TLS from the first byte", which is port 465 only.
   * On 587 the session starts in the clear and upgrades via STARTTLS, so `secure` must be
   * false there — setting it true is the usual cause of a handshake that hangs until timeout.
   * `requireTLS` then makes the upgrade mandatory rather than opportunistic, so a server that
   * fails to offer STARTTLS gets an error instead of silently sending the code unencrypted.
   */
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === "true"
    : port === 465;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });

  try {
    await transporter.sendMail({ from: fromAddress("smtp"), to, ...message });
  } catch (e) {
    // An SMTP rejection quotes the message it refused, which here contains the OTP. Keep the
    // provider's code and strip the rest rather than letting the code reach a log or the UI.
    const err = e as { responseCode?: number; code?: string; message?: string };
    const reason = err.responseCode ?? err.code ?? "unknown error";
    throw new Error(
      `Could not send the email over SMTP (${reason}). Check SMTP_HOST, SMTP_PORT and the app password.`,
    );
  } finally {
    transporter.close();
  }
}
