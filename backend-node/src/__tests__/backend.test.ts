/**
 * Tests for the parts of this backend that are *not* ports.
 *
 * The crypto and the adapters are covered by `crypto.test.ts` and `providers.test.ts`, which
 * are the Next.js app's own suites running unchanged — that they pass is the evidence the
 * vault survived the move. What's left is the new code: password hashing, the validators that
 * replace the SQL CHECK constraints, the scope helper that replaces RLS, and the serialisers
 * that are the only thing standing between a document and a leaked ciphertext.
 *
 * Nothing here touches MongoDB. Every function under test is pure or takes its data as an
 * argument, which is a property worth keeping — it's what makes this suite runnable in CI
 * with no services.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from "../auth/password";
import { readIdToken, returnTo, stateMatches } from "../auth/google";
import { appUrl } from "../config/env";
import { owned, ownedBy, scopeFor } from "../db/scope";
import {
  asBoolean,
  asIntervalDays,
  asLifecycle,
  asMetadata,
  asProviderId,
  asStrategy,
  asTier,
  optionalString,
  requireString,
  MAX_INTERVAL_DAYS,
} from "../db/validate";
import { toCurrentUser, toProject, toSecretSummary } from "../http/serialize";
import { safeEqual } from "../lib/safe-equal";
import { isDue } from "../jobs/ping";
import { summarise } from "../jobs/summary";
import { daysOfHeadroom, usageFraction, utcDay } from "../jobs/usage";
import type { ProjectDoc, SecretDoc, UserDoc } from "../db/documents";

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("password hashing", () => {
  test("a password verifies against its own hash and nothing else", () => {
    const hash = hashPassword("correct horse battery staple");
    assert.equal(verifyPassword("correct horse battery staple", hash), true);
    assert.equal(verifyPassword("correct horse battery stapl", hash), false);
    assert.equal(verifyPassword("", hash), false);
  });

  test("the same password hashes differently every time", () => {
    // Per-hash salt. Identical hashes would tell an attacker which accounts share a password.
    assert.notEqual(hashPassword("same-password"), hashPassword("same-password"));
  });

  test("the hash carries its own parameters, so the cost can be raised later", () => {
    const [scheme, n, r, p, salt, key] = hashPassword("whatever").split("$");
    assert.equal(scheme, "scrypt");
    assert.ok(Number(n) >= 1 << 15, "N should be at least 2^15");
    assert.equal(Number(r), 8);
    assert.equal(Number(p), 1);
    assert.ok(Buffer.from(salt, "base64").length >= 16);
    assert.equal(Buffer.from(key, "base64").length, 32);
  });

  test("a hash made with weaker parameters is flagged for upgrade", () => {
    assert.equal(needsRehash(hashPassword("x")), false);
    assert.equal(needsRehash("scrypt$1024$8$1$c2FsdA==$a2V5"), true);
    assert.equal(needsRehash("bcrypt$whatever"), true);
  });

  test("a malformed or tampered hash fails closed instead of throwing", () => {
    // A corrupted document must be a failed login, not a 500 that tells an attacker they
    // found something interesting.
    for (const bad of [
      "",
      "nonsense",
      "scrypt$16384$8$1$notbase64!!$x",
      "scrypt$abc$8$1$c2FsdA==$a2V5",
      "scrypt$16384$8$1$c2FsdA==$",
    ]) {
      assert.equal(verifyPassword("anything", bad), false, `should reject: ${bad}`);
    }
  });

  test("absurd scrypt parameters in a stored hash are refused, not honoured", () => {
    // Otherwise a tampered document is a denial of service we perform on ourselves: scrypt
    // with N=2^30 would try to allocate gigabytes on every login attempt.
    assert.equal(verifyPassword("x", "scrypt$1073741824$8$1$c2FsdA==$a2V5"), false);
    assert.equal(verifyPassword("x", "scrypt$16384$9999$1$c2FsdA==$a2V5"), false);
  });

  test("unicode passwords normalise, so the same keystrokes always verify", () => {
    // "é" composed vs. decomposed: visually identical, different bytes. Without NFKC a
    // password typed on one keyboard could fail to verify when typed on another.
    const composed = "café password";
    const precomposed = "café password";
    assert.notEqual(composed, precomposed);
    assert.equal(verifyPassword(precomposed, hashPassword(composed)), true);
  });

  test("the length floor is enforced and nothing else is", () => {
    assert.ok(passwordProblem("short"));
    assert.equal(passwordProblem("12345678"), null);
    // No composition rules: "one capital and one symbol" pushes people to Password1!
    assert.equal(passwordProblem("all lowercase letters no digits"), null);
    assert.ok(passwordProblem("x".repeat(600)));
  });
});

describe("scope — the RLS replacement", () => {
  test("a filter is always stamped with the scope's user", () => {
    assert.deepEqual(owned(scopeFor(USER)), { user_id: USER });
    assert.deepEqual(owned(scopeFor(USER), { provider: "neon" }), {
      provider: "neon",
      user_id: USER,
    });
  });

  test("a user_id already in the filter cannot override the scope", () => {
    /*
     * The single most important assertion in this file. If `owned` merged in the caller's
     * direction, any route that passed a user-supplied field through to a filter would become
     * a cross-tenant read — the exact failure RLS used to make impossible. The scope wins.
     */
    const filter = owned(scopeFor(USER), { user_id: OTHER } as Record<string, unknown>);
    assert.equal(filter.user_id, USER);
  });

  test("an insert cannot be stamped with anyone else's id", () => {
    assert.deepEqual(ownedBy(scopeFor(USER)), { user_id: USER });
  });

  test("a scope cannot be made without a user", () => {
    assert.throws(() => scopeFor(""), /needs a user id/);
  });
});

describe("validators — the CHECK constraints", () => {
  test("provider must be one the registry knows", () => {
    assert.equal(asProviderId("neon"), "neon");
    assert.equal(asProviderId("supabase"), "supabase");
    // MongoDB would happily store "banana"; Postgres's enum would not, and neither does this.
    assert.throws(() => asProviderId("banana"), /provider must be one of/);
    assert.throws(() => asProviderId(42), /provider must be one of/);
  });

  test("lifecycle, strategy and tier are closed sets with sensible fallbacks", () => {
    assert.equal(asLifecycle("paused"), "paused");
    assert.equal(asLifecycle(undefined), "unknown");
    assert.equal(asLifecycle(null, "active"), "active");
    assert.throws(() => asLifecycle("melted"), /lifecycle must be one of/);

    assert.equal(asStrategy("watch"), "watch");
    assert.equal(asStrategy(undefined), "ping");
    assert.throws(() => asStrategy("hope"), /strategy must be one of/);

    assert.equal(asTier("server"), "server");
    assert.equal(asTier(undefined), "personal");
    assert.throws(() => asTier("public"), /tier must be one of/);
  });

  test("interval_days is clamped rather than rejected", () => {
    assert.equal(asIntervalDays(5, 7), 5);
    assert.equal(asIntervalDays(0, 7), 1);
    assert.equal(asIntervalDays(9999, 7), MAX_INTERVAL_DAYS);
    assert.equal(asIntervalDays("not a number", 7), 7);
    assert.equal(asIntervalDays(4.6, 7), 5);
  });

  test("required strings are trimmed, and blank counts as absent", () => {
    assert.equal(requireString("  hello  ", "name"), "hello");
    assert.throws(() => requireString("   ", "name"), /name is required/);
    assert.throws(() => requireString(null, "email"), /email is required/);
    assert.equal(optionalString("  x "), "x");
    assert.equal(optionalString("   "), null);
    assert.equal(optionalString(7), null);
  });

  test("metadata is always an object, never an array or a scalar", () => {
    // It's spread into a document; an array here would produce numeric keys in Mongo.
    assert.deepEqual(asMetadata({ a: 1 }), { a: 1 });
    assert.deepEqual(asMetadata([1, 2]), {});
    assert.deepEqual(asMetadata("nope"), {});
    assert.deepEqual(asMetadata(null), {});
  });

  test("booleans accept the form-encoded spellings too", () => {
    assert.equal(asBoolean(true), true);
    assert.equal(asBoolean("on"), true);
    assert.equal(asBoolean("false"), false);
    assert.equal(asBoolean(undefined, true), true);
  });
});

describe("serialisers — what may leave the process", () => {
  const secret: SecretDoc = {
    _id: "s1",
    user_id: USER,
    account_id: null,
    project_id: "p1",
    kind: "anon_key",
    label: "Fetched from the provider",
    tier: "server",
    ciphertext: "AQIDBAUGBwgJCgsMDQ4PEBESExQ=",
    key_version: 1,
    last_used_at: null,
    last_verified_at: null,
    created_at: new Date("2026-01-02T03:04:05.000Z"),
    updated_at: new Date("2026-01-02T03:04:05.000Z"),
  };

  test("a secret summary cannot carry its ciphertext", () => {
    const json = JSON.stringify(toSecretSummary(secret));
    assert.ok(!json.includes("ciphertext"), "the field name must be absent");
    assert.ok(!json.includes(secret.ciphertext), "the value must be absent");
    // And it still carries what the inventory UI needs.
    assert.equal(toSecretSummary(secret).kind, "anon_key");
    assert.equal(toSecretSummary(secret).tier, "server");
  });

  test("the current user cannot carry a password hash or a wrapped key", () => {
    const user: UserDoc = {
      _id: USER,
      email: "someone@example.com",
      password_hash: hashPassword("hunter2"),
      display_name: "Someone",
      avatar_url: null,
      google_sub: "google-123",
      vault_initialized_at: new Date(),
      pin_salt: "c2FsdA==",
      // The thing an offline PIN attack needs. It must never be serialised.
      dek_pin: "AQIDBAUGBwgJCgsM",
      dek_srv: "DQ4PEBESExQVFhcY",
      pin_failed_attempts: 0,
      pin_locked_until: null,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date(),
    };

    const json = JSON.stringify(toCurrentUser(user));
    for (const forbidden of ["password_hash", "dek_pin", "dek_srv", "pin_salt", user.dek_pin!]) {
      assert.ok(!json.includes(forbidden), `must not leak ${forbidden}`);
    }
    // It reports *whether* they exist, which is all the UI needs.
    assert.equal(toCurrentUser(user).has_password, true);
    assert.equal(toCurrentUser(user).google_linked, true);
  });

  test("dates become ISO strings, so the payload matches the frontend's row types", () => {
    const project: ProjectDoc = {
      _id: "p1",
      user_id: USER,
      account_id: "a1",
      provider: "supabase",
      external_id: "abcdefghijklmnopqrst",
      name: "my-project",
      region: "eu-west-1",
      plan: "free",
      provider_status: "ACTIVE_HEALTHY",
      lifecycle: "active",
      strategy: "ping",
      keep_alive: true,
      interval_days: 5,
      repo_url: null,
      local_path: null,
      notes: null,
      metadata: { ping_table: "keep_alive" },
      last_pinged_at: new Date("2026-02-03T04:05:06.000Z"),
      last_status: "ok",
      last_error: null,
      discovered_at: null,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
    };

    const json = toProject(project);
    assert.equal(json.id, "p1");
    assert.equal(json.last_pinged_at, "2026-02-03T04:05:06.000Z");
    assert.equal(json.created_at, "2026-01-01T00:00:00.000Z");
    assert.equal(json.discovered_at, null);
    // `_id` is renamed, not duplicated.
    assert.ok(!("_id" in json));
  });
});

describe("the due check", () => {
  const base = { keep_alive: true, interval_days: 5 };
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  test("a project that has never been pinged is due", () => {
    assert.equal(isDue({ ...base, last_pinged_at: null }), true);
  });

  test("keep-alive off is never due, however long it has been", () => {
    assert.equal(isDue({ ...base, keep_alive: false, last_pinged_at: daysAgo(90) }), false);
  });

  test("the interval is respected", () => {
    assert.equal(isDue({ ...base, last_pinged_at: daysAgo(1) }), false);
    assert.equal(isDue({ ...base, last_pinged_at: daysAgo(6) }), true);
  });

  test("a project due just after the sweep's hour isn't skipped a whole day", () => {
    /*
     * The slack is the whole point of the function. A daily sweep at a fixed time will see a
     * project whose interval elapses in 23h50m; without slack it waits for tomorrow's run and
     * the effective interval becomes six days, not five. With a 30-day Atlas window and a
     * 20-day interval that drift is harmless; with a 7-day Supabase window it is not.
     */
    const almost = new Date(Date.now() - (5 * 86_400_000 - 90 * 60_000));
    assert.equal(isDue({ ...base, last_pinged_at: almost }), true);
  });
});

describe("sweep summary", () => {
  const result = (over: Partial<Parameters<typeof summarise>[0][number]>) => ({
    projectId: "p",
    provider: "supabase",
    name: "n",
    status: "ok" as const,
    strategy: "ping" as const,
    httpStatus: 200,
    durationMs: 10,
    error: null,
    via: null,
    ...over,
  });

  test("pings, watches and checks are counted separately", () => {
    // Three different claims. Collapsing them into "processed" would let a usage read look
    // like a keep-alive, which is the one thing docs/ARCHITECTURE.md §1 forbids.
    const { payload } = summarise([
      result({ strategy: "ping" }),
      result({ strategy: "watch", provider: "neon" }),
      result({ strategy: "alert_only", provider: "appwrite" }),
      result({ strategy: "ping", status: "error", error: "boom" }),
    ]);

    assert.equal(payload.processed, 4);
    assert.equal(payload.pinged, 2);
    assert.equal(payload.watched, 1);
    assert.equal(payload.checked, 1);
    assert.equal(payload.ok, 3);
    assert.equal(payload.failed, 1);
  });

  test("failures are grouped by provider, so one provider's outage is visible", () => {
    const { payload, failures } = summarise([
      result({ provider: "neon", status: "error", error: "429" }),
      result({ provider: "neon", status: "error", error: "429" }),
      result({ provider: "supabase" }),
    ]);

    assert.equal(failures.length, 2);
    assert.deepEqual(payload.byProvider.neon, { ok: 0, failed: 2, strategy: "ping" });
    assert.equal(payload.byProvider.supabase.ok, 1);
  });
});

describe("usage arithmetic", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "u1",
    project_id: "p1",
    metric: "compute_cu_hours",
    value: 50,
    limit_value: 100,
    unit: "CU-hours",
    period_start: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    period_end: null,
    captured_at: new Date().toISOString(),
    captured_on: utcDay(new Date()),
    ...over,
  });

  test("the UTC day is the first ten characters of the ISO instant", () => {
    assert.equal(utcDay(new Date("2026-03-04T23:59:59.999Z")), "2026-03-04");
    // Independent of the server's timezone, because toISOString is always UTC.
    assert.equal(utcDay(new Date("2026-03-04T00:00:00.000Z")), "2026-03-04");
  });

  test("headroom projects the current burn rate", () => {
    // 50 of 100 used over 10 days = 5/day, 50 left, so ~10 days.
    const days = daysOfHeadroom(row());
    assert.ok(days !== null && Math.abs(days - 10) < 0.5, `got ${days}`);
  });

  test("headroom is null when the question doesn't apply, and zero when spent", () => {
    assert.equal(daysOfHeadroom(row({ limit_value: null })), null);
    assert.equal(daysOfHeadroom(row({ value: 0 })), null);
    assert.equal(daysOfHeadroom(row({ period_start: null })), null);
    assert.equal(daysOfHeadroom(row({ value: 120 })), 0);
  });

  test("the used fraction is null when there is no known limit", () => {
    assert.equal(usageFraction(row()), 0.5);
    assert.equal(usageFraction(row({ limit_value: null })), null);
    assert.equal(usageFraction(row({ limit_value: 0 })), null);
  });
});

describe("google sign-in", () => {
  const idToken = (claims: Record<string, unknown>) =>
    [
      Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      "signature",
    ].join(".");

  test("the identity comes out of the id_token's claims", () => {
    const identity = readIdToken(
      idToken({
        sub: "1234567890",
        email: "someone@example.com",
        email_verified: true,
        name: "Someone",
        picture: "https://example.com/a.png",
      }),
    );
    assert.equal(identity.sub, "1234567890");
    assert.equal(identity.email, "someone@example.com");
    assert.equal(identity.emailVerified, true);
    assert.equal(identity.name, "Someone");
  });

  test("email_verified is accepted as a boolean or the string Google sometimes sends", () => {
    // This flag gates account linking by email, so misreading "true" as falsy would lock
    // people out — and misreading "false" as truthy would be the takeover hole.
    assert.equal(readIdToken(idToken({ sub: "1", email: "a@b.c", email_verified: "true" })).emailVerified, true);
    assert.equal(readIdToken(idToken({ sub: "1", email: "a@b.c", email_verified: "false" })).emailVerified, false);
    assert.equal(readIdToken(idToken({ sub: "1", email: "a@b.c" })).emailVerified, false);
  });

  test("a token with no subject or no email is refused", () => {
    assert.throws(() => readIdToken(idToken({ email: "a@b.c" })), /no account id or email/);
    assert.throws(() => readIdToken(idToken({ sub: "1" })), /no account id or email/);
    assert.throws(() => readIdToken("not.a.jwt"), /unreadable/);
    assert.throws(() => readIdToken("onlyonepart"), /malformed/);
  });

  test("the state check is exact, and a missing cookie never matches", () => {
    assert.equal(stateMatches("abc", "abc"), true);
    assert.equal(stateMatches("abc", "abd"), false);
    assert.equal(stateMatches("abc", "ab"), false);
    assert.equal(stateMatches("abc", null), false);
    assert.equal(stateMatches(undefined, "abc"), false);
  });

  test("the post-sign-in redirect cannot be pointed off-site", () => {
    // `//evil.example` is the one that catches people: it's protocol-relative, so a browser
    // reads it as a different host even though it starts with a slash.
    const base = appUrl();
    assert.equal(returnTo("//evil.example/steal"), base);
    assert.equal(returnTo("https://evil.example"), base);
    assert.equal(returnTo("not-a-path"), base);
    assert.equal(returnTo("/vault"), `${base}/vault`);
  });
});

describe("constant-time compare", () => {
  test("equal strings match, different ones don't", () => {
    assert.equal(safeEqual("secret-value", "secret-value"), true);
    assert.equal(safeEqual("secret-value", "secret-valuf"), false);
  });

  test("a length mismatch is rejected without indexing past the end", () => {
    assert.equal(safeEqual("short", "much longer value"), false);
    assert.equal(safeEqual("", ""), true);
  });
});
