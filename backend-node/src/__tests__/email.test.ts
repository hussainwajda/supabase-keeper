/**
 * Vault OTP transport selection. Run with: pnpm test
 *
 * Precedence only — nothing here opens a socket or sends mail. The property that matters
 * most is the last one: dev-echo must stay impossible in production, because a deployment
 * that "sends" codes to its own log hands the recovery path to anyone who can read logs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { otpTransport, otpAvailable } from "../vault/email";

/** `NODE_ENV` is declared read-only by the Node types, so writes go through the index type. */
const env = process.env as Record<string, string | undefined>;

const KEYS = [
  "RESEND_API_KEY",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "KEEPSTACK_OTP_DEV_ECHO",
  "NODE_ENV",
];

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function reset() {
  for (const k of KEYS) delete env[k];
}

test("no config at all -> none", () => {
  reset();
  assert.equal(otpTransport(), "none");
  assert.equal(otpAvailable(), false);
});

test("full smtp triple -> smtp", () => {
  reset();
  env.SMTP_HOST = "smtp.gmail.com";
  env.SMTP_USER = "a@gmail.com";
  env.SMTP_PASS = "app-password";
  assert.equal(otpTransport(), "smtp");
  assert.equal(otpAvailable(), true);
});

test("partial smtp config does not count", () => {
  reset();
  env.SMTP_HOST = "smtp.gmail.com";
  env.SMTP_USER = "a@gmail.com";
  assert.equal(otpTransport(), "none", "missing SMTP_PASS must not enable smtp");
});

test("resend beats smtp", () => {
  reset();
  env.RESEND_API_KEY = "re_x";
  env.SMTP_HOST = "smtp.gmail.com";
  env.SMTP_USER = "a@gmail.com";
  env.SMTP_PASS = "p";
  assert.equal(otpTransport(), "resend");
});

test("smtp beats dev-echo", () => {
  reset();
  env.KEEPSTACK_OTP_DEV_ECHO = "true";
  env.SMTP_HOST = "smtp.gmail.com";
  env.SMTP_USER = "a@gmail.com";
  env.SMTP_PASS = "p";
  assert.equal(otpTransport(), "smtp");
});

test("dev-echo still works alone outside production", () => {
  reset();
  env.KEEPSTACK_OTP_DEV_ECHO = "true";
  assert.equal(otpTransport(), "dev-echo");
});

test("dev-echo is refused in production", () => {
  reset();
  env.NODE_ENV = "production";
  env.KEEPSTACK_OTP_DEV_ECHO = "true";
  assert.equal(otpTransport(), "none");
  env.NODE_ENV = ORIGINAL_NODE_ENV;
});
