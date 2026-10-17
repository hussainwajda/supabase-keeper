/**
 * Supabase adapter unit tests. Run with: pnpm test
 *
 * Pure logic only — no network. The parts that talk to the Management API are exercised by
 * hand against a real token; see docs/ROADMAP.md for what's verified where.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { supabaseAdapter, extractRef, lifecycleFromStatus } from "../supabase";
import { parseIdentifier } from "../registry";

const REF = "abcdefghijklmnopqrst";

describe("identifier parsing", () => {
  test("accepts a bare 20-character ref", () => {
    assert.deepEqual(supabaseAdapter.parse(REF), { externalId: REF, hint: "project ref" });
  });

  test("pulls a ref out of an API URL", () => {
    assert.equal(supabaseAdapter.parse(`https://${REF}.supabase.co`)?.externalId, REF);
    assert.equal(supabaseAdapter.parse(`https://${REF}.supabase.in`)?.externalId, REF);
  });

  test("pulls a ref out of a dashboard URL", () => {
    assert.equal(
      supabaseAdapter.parse(`https://supabase.com/dashboard/project/${REF}/editor`)?.externalId,
      REF,
    );
  });

  test("pulls a ref out of a pooler connection string", () => {
    const uri = `postgresql://postgres.${REF}:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`;
    assert.equal(supabaseAdapter.parse(uri)?.externalId, REF);
  });

  test("pulls a ref out of a whole .env blob", () => {
    const env = [
      "# my project",
      "NEXT_PUBLIC_SUPABASE_URL=https://" + REF + ".supabase.co",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiJ9.whatever",
      "OTHER=1",
    ].join("\n");
    assert.equal(supabaseAdapter.parse(env)?.externalId, REF);
  });

  test("is case-insensitive about the surrounding text", () => {
    assert.equal(supabaseAdapter.parse(`HTTPS://${REF.toUpperCase()}.SUPABASE.CO`)?.externalId, REF);
  });

  test("rejects things that aren't refs", () => {
    assert.equal(supabaseAdapter.parse(""), null);
    assert.equal(supabaseAdapter.parse("hello world"), null);
    assert.equal(supabaseAdapter.parse("abc"), null);
    // 19 and 21 characters: the length is exact.
    assert.equal(supabaseAdapter.parse("a".repeat(19)), null);
    assert.equal(supabaseAdapter.parse("a".repeat(21)), null);
  });

  test("the registry routes a Supabase URL to the Supabase adapter", () => {
    assert.deepEqual(parseIdentifier(`https://${REF}.supabase.co`), {
      provider: "supabase",
      externalId: REF,
      hint: "project URL",
    });
    assert.equal(parseIdentifier("nothing recognisable here"), null);
  });

  test("extractRef stays exported for callers that only want the ref", () => {
    assert.equal(extractRef(`https://${REF}.supabase.co`), REF);
    assert.equal(extractRef("nope"), null);
  });
});

describe("lifecycle mapping", () => {
  test("INACTIVE means paused, which is the one that matters", () => {
    assert.equal(lifecycleFromStatus("INACTIVE"), "paused");
    assert.equal(lifecycleFromStatus("PAUSING"), "paused");
    assert.equal(lifecycleFromStatus("PAUSE_FAILED"), "paused");
  });

  test("healthy and unhealthy are both active", () => {
    assert.equal(lifecycleFromStatus("ACTIVE_HEALTHY"), "active");
    assert.equal(lifecycleFromStatus("ACTIVE_UNHEALTHY"), "active");
  });

  test("transitional states are idle", () => {
    for (const s of ["COMING_UP", "RESTORING", "RESTARTING", "UPGRADING", "RESIZING", "GOING_DOWN"]) {
      assert.equal(lifecycleFromStatus(s), "idle", s);
    }
  });

  test("REMOVED means deleted, and anything unrecognised is unknown", () => {
    assert.equal(lifecycleFromStatus("REMOVED"), "deleted");
    assert.equal(lifecycleFromStatus("SOMETHING_NEW"), "unknown");
    assert.equal(lifecycleFromStatus(null), "unknown");
    assert.equal(lifecycleFromStatus(undefined), "unknown");
  });
});

describe("credential validation", () => {
  const anonField = supabaseAdapter.projectFields.find((f) => f.key === "anon_key")!;
  const patField = supabaseAdapter.accountFields.find((f) => f.key === "pat")!;

  /** A JWT with the given role, unsigned — only the payload is inspected. */
  function jwt(role: string): string {
    const part = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url").replace(/=+$/, "");
    return `${part({ alg: "HS256" })}.${part({ role, iss: "supabase" })}.sig`;
  }

  test("rejects a service_role JWT in the anon-key field", () => {
    assert.ok(anonField.validate!(jwt("service_role")));
  });

  test("rejects an sb_secret_ key in the anon-key field", () => {
    assert.ok(anonField.validate!("sb_secret_abc123"));
  });

  test("accepts a legitimate anon key", () => {
    assert.equal(anonField.validate!(jwt("anon")), null);
    assert.equal(anonField.validate!("sb_publishable_abc123"), null);
  });

  test("requires the sbp_ prefix on a personal access token", () => {
    assert.equal(patField.validate!("sbp_0123456789abcdef"), null);
    assert.ok(patField.validate!("eyJhbGciOiJIUzI1NiJ9.x.y"));
  });

  test("the database password is personal tier, the token is server tier", () => {
    // This split is the whole point of the two-tier model: the sweep needs the token
    // unattended, and never needs the database password.
    assert.equal(patField.tier, "server");
    assert.equal(supabaseAdapter.projectFields.find((f) => f.key === "db_password")!.tier, "personal");
    assert.equal(anonField.tier, "server");
  });
});

describe("policy", () => {
  test("describes Supabase's real inactivity rule", () => {
    assert.equal(supabaseAdapter.policy.strategy, "ping");
    assert.equal(supabaseAdapter.policy.pausesAfterDays, 7);
    // Supabase keeps paused data, unlike Appwrite. A countdown would be a lie here.
    assert.equal(supabaseAdapter.policy.deletesAfterDays, null);
    assert.ok(supabaseAdapter.policy.defaultIntervalDays < 7, "must leave margin before the pause");
  });

  test("claims only capabilities it implements", () => {
    const c = supabaseAdapter.capabilities;
    assert.equal(c.discover, !!supabaseAdapter.discover);
    assert.equal(c.ping, !!supabaseAdapter.ping);
    assert.equal(c.revive, !!supabaseAdapter.revive);
    assert.equal(c.health, !!supabaseAdapter.health);
    // `watch` is false and there is no usage() — Supabase pauses, it doesn't meter.
    assert.equal(c.watch, false);
    assert.equal(supabaseAdapter.usage, undefined);
  });
});

describe("connection strings", () => {
  const project = (metadata: Record<string, unknown> = {}) => ({
    externalId: REF,
    name: "test",
    metadata,
  });

  test("returns nothing without a password", () => {
    assert.deepEqual(supabaseAdapter.connectionStrings!(project(), {}), {
      pooled: null,
      direct: null,
    });
  });

  test("builds a direct URL from the discovered host", () => {
    const out = supabaseAdapter.connectionStrings!(project({ db_host: `db.${REF}.supabase.co` }), {
      db_password: "pw",
    });
    assert.match(out.direct!, /^postgresql:\/\/postgres:pw@db\./);
    assert.match(out.direct!, /:5432\/postgres$/);
  });

  test("omits the pooled URL when the pooler host is unknown", () => {
    // Guessing `aws-0-<region>.pooler.supabase.com` has broken before; a correct absence
    // beats a plausible wrong answer.
    assert.equal(supabaseAdapter.connectionStrings!(project(), { db_password: "pw" }).pooled, null);
  });

  test("builds the pooled URL when the pooler host is known", () => {
    const out = supabaseAdapter.connectionStrings!(
      project({ pooler_host: "aws-0-eu-west-2.pooler.supabase.com" }),
      { db_password: "pw" },
    );
    assert.match(out.pooled!, /^postgresql:\/\/postgres\.abcdefghijklmnopqrst:pw@/);
    assert.match(out.pooled!, /:6543\/postgres\?pgbouncer=true/);
  });

  test("percent-encodes a password with URL-significant characters", () => {
    const out = supabaseAdapter.connectionStrings!(project(), { db_password: "p@ss:w/rd?#[]" });
    assert.ok(!out.direct!.includes("p@ss"), "raw password must not appear unencoded");
    assert.ok(out.direct!.includes(encodeURIComponent("p@ss:w/rd?#[]")));
  });
});
