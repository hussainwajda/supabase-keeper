/**
 * Crypto unit tests. Run with: pnpm test:crypto
 *
 * These matter more than anything else in Keepstack — the whole vault rests on this module
 * behaving exactly as docs/SECURITY.md describes. They use throwaway keys from the
 * environment and never touch a database.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { aad, constantTimeEqual, open, openToString, seal } from "../crypto/aead";
import {
  createDek,
  createPinSalt,
  createSessionToken,
  openDekFromSession,
  sealDekForSession,
  sessionTokenHash,
  unwrapDekWithMaster,
  unwrapDekWithPin,
  wrapDekWithMaster,
  wrapDekWithPin,
} from "../crypto/dek";
import { vaultEnvProblems } from "../crypto/env";
import {
  openPersonalSecret,
  openServerSecret,
  sealPersonalSecret,
  sealServerSecret,
} from "../crypto/secrets";

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const PIN = "246810";

describe("environment", () => {
  test("validates cleanly with two distinct 32-byte keys", () => {
    assert.deepEqual(vaultEnvProblems(), []);
  });
});

describe("AEAD", () => {
  const key = Buffer.alloc(32, 7);

  test("round-trips a value", () => {
    assert.equal(openToString(key, seal(key, "hello world")), "hello world");
  });

  test("rejects a wrong key", () => {
    assert.equal(open(Buffer.alloc(32, 8), seal(key, "hello")), null);
  });

  test("rejects a tampered authentication tag", () => {
    const raw = Buffer.from(seal(key, "hello"), "base64");
    raw[raw.length - 1] ^= 0xff;
    assert.equal(open(key, raw.toString("base64")), null);
  });

  test("rejects tampered ciphertext", () => {
    const raw = Buffer.from(seal(key, "hello world, at length"), "base64");
    raw[20] ^= 0x01;
    assert.equal(open(key, raw.toString("base64")), null);
  });

  test("returns null for malformed input instead of throwing", () => {
    assert.equal(open(key, ""), null);
    assert.equal(open(key, "!!!not base64!!!"), null);
    assert.equal(open(key, Buffer.from([9, 1, 2]).toString("base64")), null);
  });

  test("AAD binds a blob to its context", () => {
    const bound = seal(key, "secret", aad("ctx-a"));
    assert.equal(openToString(key, bound, aad("ctx-a")), "secret");
    assert.equal(open(key, bound, aad("ctx-b")), null);
    assert.equal(open(key, bound), null);
  });

  test("2000 seals produce 2000 distinct IVs", () => {
    // A repeated IV under one key is catastrophic for GCM, so this is worth asserting.
    const ivs = new Set(
      Array.from({ length: 2000 }, () =>
        Buffer.from(seal(key, "x"), "base64").subarray(1, 13).toString("hex"),
      ),
    );
    assert.equal(ivs.size, 2000);
  });

  test("unicode, control characters and a 5KB value survive intact", () => {
    const weird = `pâsswörd🔐\n\ttab\u0000null${"x".repeat(5000)}`;
    assert.equal(openToString(key, seal(key, weird)), weird);
  });
});

describe("DEK wrapped by PIN", () => {
  const dek = createDek();
  const salt = createPinSalt();
  const wrapped = wrapDekWithPin(dek, PIN, salt, USER);

  test("DEK is 32 bytes", () => {
    assert.equal(dek.length, 32);
  });

  test("correct PIN unwraps it", () => {
    assert.ok(constantTimeEqual(unwrapDekWithPin(wrapped, PIN, salt, USER)!, dek));
  });

  test("wrong PIN returns null", () => {
    assert.equal(unwrapDekWithPin(wrapped, "246811", salt, USER), null);
  });

  test("wrong salt returns null", () => {
    assert.equal(unwrapDekWithPin(wrapped, PIN, createPinSalt(), USER), null);
  });

  test("another user's id cannot unwrap it", () => {
    assert.equal(unwrapDekWithPin(wrapped, PIN, salt, OTHER), null);
  });

  test("the PIN is trimmed, so stray whitespace doesn't lock you out", () => {
    assert.ok(constantTimeEqual(unwrapDekWithPin(wrapped, `  ${PIN}  `, salt, USER)!, dek));
  });
});

describe("DEK wrapped by master key (the OTP recovery path)", () => {
  const dek = createDek();
  const salt = createPinSalt();
  const srv = wrapDekWithMaster(dek, USER);
  const pin = wrapDekWithPin(dek, PIN, salt, USER);

  test("master key unwraps it", () => {
    assert.ok(constantTimeEqual(unwrapDekWithMaster(srv, USER)!, dek));
  });

  test("it is bound to the user", () => {
    assert.equal(unwrapDekWithMaster(srv, OTHER), null);
  });

  test("the two wrapped copies are not interchangeable", () => {
    assert.equal(unwrapDekWithMaster(pin, USER), null);
    assert.equal(unwrapDekWithPin(srv, PIN, salt, USER), null);
  });
});

describe("vault sessions", () => {
  const dek = createDek();
  const token = createSessionToken();
  const sealed = sealDekForSession(dek, token, USER);

  test("the token unseals the DEK", () => {
    assert.ok(constantTimeEqual(openDekFromSession(sealed, token, USER)!, dek));
  });

  test("a different token cannot unseal it", () => {
    assert.equal(openDekFromSession(sealed, createSessionToken(), USER), null);
  });

  test("a session row cannot be reused by another user", () => {
    assert.equal(openDekFromSession(sealed, token, OTHER), null);
  });

  test("the stored hash is stable, distinct, and leaks no token material", () => {
    const h = sessionTokenHash(token);
    assert.equal(h, sessionTokenHash(token));
    assert.notEqual(h, sessionTokenHash(createSessionToken()));
    assert.ok(!h.includes(token));
  });
});

describe("secret tiers", () => {
  const dek = createDek();

  test("a server-tier secret is bound to user and kind", () => {
    const blob = sealServerSecret("sbp_token_value", USER, "pat");
    assert.equal(openServerSecret(blob, USER, "pat"), "sbp_token_value");
    assert.equal(openServerSecret(blob, USER, "anon_key"), null);
    assert.equal(openServerSecret(blob, OTHER, "pat"), null);
  });

  test("a personal-tier secret needs the right DEK", () => {
    const blob = sealPersonalSecret("hunter2", dek, USER, "db_password");
    assert.equal(openPersonalSecret(blob, dek, USER, "db_password"), "hunter2");
    assert.equal(openPersonalSecret(blob, createDek(), USER, "db_password"), null);
  });

  test("a personal blob cannot be decrypted through the server tier", () => {
    // The important cross-tier case: moving a personal ciphertext into a server row must not
    // let the unattended server read it, even with the row's `kind` left unchanged.
    const blob = sealPersonalSecret("hunter2", dek, USER, "db_password");
    assert.equal(openServerSecret(blob, USER, "db_password"), null);
  });

  test("a server blob cannot be decrypted through the personal tier", () => {
    const blob = sealServerSecret("anon-key-value", USER, "anon_key");
    assert.equal(openPersonalSecret(blob, dek, USER, "anon_key"), null);
  });
});
