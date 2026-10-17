/**
 * Neon adapter unit tests. Run with: pnpm test
 *
 * Neon is the `watch` provider, so the tests that matter most are the ones asserting it
 * never claims to be pingable — that is the property the whole strategy model rests on.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { neonAdapter } from "../neon";
import { parseIdentifier } from "../registry";
import { daysOfHeadroom, usageFraction, utcDay, type UsageRow } from "../../usage";

const PROJECT = "fragrant-dew-12345678";

describe("identifier parsing", () => {
  test("accepts a bare project id", () => {
    assert.deepEqual(neonAdapter.parse(PROJECT), { externalId: PROJECT, hint: "project ID" });
  });

  test("pulls the id out of a console URL", () => {
    assert.equal(
      neonAdapter.parse(`https://console.neon.tech/app/projects/${PROJECT}/branches`)?.externalId,
      PROJECT,
    );
  });

  test("pulls the id out of a connection string's endpoint host", () => {
    const uri = `postgresql://neondb_owner:pw@ep-${PROJECT}.eu-central-1.aws.neon.tech/neondb?sslmode=require`;
    assert.equal(neonAdapter.parse(uri)?.externalId, PROJECT);
  });

  test("rejects a Supabase ref, so the two providers don't collide", () => {
    assert.equal(neonAdapter.parse("abcdefghijklmnopqrst"), null);
  });

  test("the registry routes each provider's identifier to the right adapter", () => {
    assert.equal(parseIdentifier(`https://${PROJECT}.supabase.co`)?.provider, undefined);
    assert.equal(parseIdentifier(`https://console.neon.tech/app/projects/${PROJECT}`)?.provider, "neon");
    assert.equal(parseIdentifier("https://abcdefghijklmnopqrst.supabase.co")?.provider, "supabase");
  });
});

describe("policy — the watch model", () => {
  test("is a watch provider with no inactivity deadline", () => {
    assert.equal(neonAdapter.policy.strategy, "watch");
    // The whole point: Neon does not pause for being idle, so there is no clock to reset.
    assert.equal(neonAdapter.policy.pausesAfterDays, null);
    assert.equal(neonAdapter.policy.deletesAfterDays, null);
  });

  test("never claims to be pingable, and has no ping to call", () => {
    // If this ever regresses, the UI would offer an interval picker and the sweep would
    // start spending the user's compute budget to solve a problem Neon doesn't have.
    assert.equal(neonAdapter.capabilities.ping, false);
    assert.equal(neonAdapter.ping, undefined);
  });

  test("claims watch, and implements it", () => {
    assert.equal(neonAdapter.capabilities.watch, true);
    assert.ok(neonAdapter.usage);
  });

  test("revive explains itself instead of silently doing nothing", async () => {
    assert.equal(neonAdapter.capabilities.revive, false);
    await assert.rejects(() => neonAdapter.revive!({ externalId: PROJECT, name: "x", metadata: {} }, {}), /never paused/i);
  });

  test("the summary explains why there is no ping", () => {
    assert.match(neonAdapter.policy.summary, /compute-hours/i);
    assert.match(neonAdapter.policy.summary, /scales to zero/i);
  });
});

describe("credential tiers", () => {
  test("the API key is server tier and the role password is personal", () => {
    assert.equal(neonAdapter.accountFields.find((f) => f.key === "api_key")!.tier, "server");
    assert.equal(neonAdapter.projectFields.find((f) => f.key === "db_password")!.tier, "personal");
    assert.equal(neonAdapter.projectFields.find((f) => f.key === "connection_string")!.tier, "personal");
  });
});

describe("connection strings", () => {
  const project = (metadata: Record<string, unknown> = {}) => ({
    externalId: PROJECT,
    name: "x",
    metadata,
  });

  test("derives both URLs from a stored connection string", () => {
    const direct = `postgresql://neondb_owner:pw@ep-${PROJECT}.eu-central-1.aws.neon.tech/neondb?sslmode=require`;
    const out = neonAdapter.connectionStrings!(project(), { connection_string: direct });
    assert.ok(out.pooled!.includes("-pooler."), "pooled host must carry the -pooler suffix");
    assert.ok(!out.direct!.includes("-pooler."), "direct host must not");
  });

  test("leaves an already-pooled string pooled", () => {
    const pooled = `postgresql://neondb_owner:pw@ep-${PROJECT}-pooler.eu-central-1.aws.neon.tech/neondb`;
    const out = neonAdapter.connectionStrings!(project(), { connection_string: pooled });
    assert.equal(out.pooled, pooled);
    assert.ok(!out.direct!.includes("-pooler."));
  });

  test("returns nothing when the endpoint host is unknown", () => {
    // Neon's host contains a generated endpoint id that can't be derived from the project id,
    // so guessing would produce a string that silently fails to connect.
    assert.deepEqual(neonAdapter.connectionStrings!(project(), { db_password: "pw" }), {
      pooled: null,
      direct: null,
    });
  });

  test("percent-encodes the password", () => {
    const out = neonAdapter.connectionStrings!(
      project({ endpoint_host: `ep-${PROJECT}.eu-central-1.aws.neon.tech` }),
      { db_password: "p@ss:w/rd" },
    );
    assert.ok(out.direct!.includes(encodeURIComponent("p@ss:w/rd")));
    assert.ok(!out.direct!.includes("p@ss:w/rd"));
  });
});

describe("the captured_on day key", () => {
  // This has to match migration 0007's column default, `(now() AT TIME ZONE 'UTC')::date`.
  // It is the upsert's conflict target, so "one reading per day" only holds if the app and
  // the database agree on which day it is.
  test("is the UTC calendar day", () => {
    assert.equal(utcDay("2026-10-17T23:59:59.999Z"), "2026-10-17");
    assert.equal(utcDay("2026-10-18T00:00:00.000Z"), "2026-10-18");
  });

  test("ignores the host timezone", () => {
    // 2026-10-18T02:30 in +05:30 is still 2026-10-17 in UTC. A local-date derivation would
    // return the 18th here and silently create two rows for one day.
    assert.equal(utcDay("2026-10-18T02:30:00.000+05:30"), "2026-10-17");
    assert.equal(utcDay("2026-10-17T20:00:00.000-07:00"), "2026-10-18");
  });

  test("is stable across repeated calls on the same instant", () => {
    const iso = new Date().toISOString();
    assert.equal(utcDay(iso), utcDay(iso));
    assert.match(utcDay(iso), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("headroom maths", () => {
  const row = (over: Partial<UsageRow> = {}): UsageRow => ({
    id: 1,
    project_id: "p",
    metric: "compute_cu_hours",
    value: 50,
    limit_value: 100,
    unit: "CU-hours",
    // 10 days into the period.
    period_start: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    period_end: null,
    captured_at: new Date().toISOString(),
    ...over,
  });

  test("projects remaining days from the current burn rate", () => {
    // 50 of 100 in 10 days = 5/day, 50 left => ~10 days.
    const days = daysOfHeadroom(row())!;
    assert.ok(days > 9 && days < 11, `expected ~10, got ${days}`);
  });

  test("reports zero when the allowance is already spent", () => {
    assert.equal(daysOfHeadroom(row({ value: 100 })), 0);
    assert.equal(daysOfHeadroom(row({ value: 150 })), 0);
  });

  test("returns null when there is nothing to project from", () => {
    assert.equal(daysOfHeadroom(row({ limit_value: null })), null);
    assert.equal(daysOfHeadroom(row({ value: 0 })), null);
    // A point-in-time metric like storage has no period to burn through.
    assert.equal(daysOfHeadroom(row({ period_start: null })), null);
  });

  test("usageFraction is a plain ratio, and null without a limit", () => {
    assert.equal(usageFraction(row()), 0.5);
    assert.equal(usageFraction(row({ limit_value: null })), null);
    // Over-limit is allowed to exceed 1 so the caller can show "107%".
    assert.equal(usageFraction(row({ value: 107 })), 1.07);
  });
});
