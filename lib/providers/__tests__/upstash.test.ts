/**
 * Upstash adapter unit tests. Run with: pnpm test
 *
 * `fetch` is stubbed here rather than hitting the network, because the cases that matter are
 * the ambiguous ones — a 401 from the REST API means either a rotated token or an archived
 * database, and only one of those may set a lifecycle.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { upstashAdapter } from "../upstash";
import { parseIdentifier } from "../registry";
import { daysOfHeadroom, type UsageRow } from "../../usage";

const ID = "3a4f1b2c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const ENDPOINT = "eu1-fancy-cat-12345.upstash.io";
const project = {
  externalId: ID,
  name: "cache",
  metadata: { database_id: ID, endpoint: ENDPOINT, port: 6379 },
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub `fetch`, recording the calls so a test can assert nothing was sent. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("identifier parsing", () => {
  test("accepts a console URL", () => {
    assert.deepEqual(upstashAdapter.parse(`https://console.upstash.com/redis/${ID}`), {
      externalId: ID,
      hint: "console URL",
    });
  });

  test("accepts a bare database id", () => {
    assert.deepEqual(upstashAdapter.parse(ID), { externalId: ID, hint: "database ID" });
  });

  test("accepts the REST endpoint host", () => {
    assert.deepEqual(upstashAdapter.parse(`https://${ENDPOINT}`), {
      externalId: ENDPOINT,
      hint: "REST endpoint",
    });
  });

  test("accepts a rediss:// connection string and says where it found it", () => {
    const parsed = upstashAdapter.parse(`rediss://default:somepassword@${ENDPOINT}:6379`);
    assert.equal(parsed?.externalId, ENDPOINT);
    assert.equal(parsed?.hint, "connection string");
  });

  test("prefers the endpoint over an unrelated UUID in a pasted .env", () => {
    // The endpoint is the thing a user actually has to hand, and a .env often carries other
    // UUIDs. Resolving to one of those would send them to the wrong database.
    const env = [
      "SENTRY_ID=11111111-2222-3333-4444-555555555555",
      `UPSTASH_REDIS_REST_URL=https://${ENDPOINT}`,
      "UPSTASH_REDIS_REST_TOKEN=AX1sASQgN2Y...",
    ].join("\n");
    assert.equal(upstashAdapter.parse(env)?.externalId, ENDPOINT);
  });

  test("rejects other providers' identifiers, so the five don't collide", () => {
    assert.equal(upstashAdapter.parse("abcdefghijklmnopqrst"), null);
    assert.equal(upstashAdapter.parse("fragrant-dew-12345678"), null);
    assert.equal(upstashAdapter.parse("https://cluster0.ab12c.mongodb.net"), null);
  });

  test("the registry routes Upstash identifiers to this adapter", () => {
    assert.equal(parseIdentifier(`https://${ENDPOINT}`)?.provider, "upstash");
    assert.equal(parseIdentifier(`https://console.upstash.com/redis/${ID}`)?.provider, "upstash");
  });
});

describe("console URL", () => {
  test("links to the database when its id is known", () => {
    assert.equal(
      upstashAdapter.consoleUrl(project),
      `https://console.upstash.com/redis/${ID}`,
    );
  });

  test("falls back to the list rather than building a URL that 404s", () => {
    // A database registered by pasting its endpoint has no id, and the detail route needs one.
    assert.equal(
      upstashAdapter.consoleUrl({ externalId: ENDPOINT, name: "cache", metadata: {} }),
      "https://console.upstash.com/redis",
    );
  });
});

describe("policy", () => {
  test("takes the pessimistic reading of the inactivity window", () => {
    // The FAQ says 14 days in one place and 30 in another, neither dated. Assuming 30 would
    // risk letting a database be archived while the dashboard said it was fine.
    assert.equal(upstashAdapter.policy.pausesAfterDays, 14);
    // And the interval leaves at least half that window as margin, so one failed cron run
    // doesn't put the database at risk.
    assert.ok(upstashAdapter.policy.defaultIntervalDays <= 14 / 2);
  });

  test("calls it archiving, because that is what Upstash does to the instance", () => {
    assert.equal(upstashAdapter.policy.pauseNoun, "archived");
    // The backup survives, so this is not a deletion clock — unlike Appwrite's.
    assert.equal(upstashAdapter.policy.deletesAfterDays, null);
  });

  test("is the first provider that both pings and watches", () => {
    assert.equal(upstashAdapter.policy.strategy, "ping");
    assert.equal(upstashAdapter.capabilities.ping, true);
    assert.ok(upstashAdapter.ping);
    // An inactivity clock *and* a monthly command budget.
    assert.equal(upstashAdapter.capabilities.watch, true);
    assert.ok(upstashAdapter.usage);
  });

  test("never claims it can un-archive", () => {
    // Recovery is console-only: create a new database and import the backup.
    assert.equal(upstashAdapter.capabilities.revive, false);
    assert.equal(upstashAdapter.revive, undefined);
  });
});

describe("credential tiers", () => {
  const all = [...upstashAdapter.accountFields, ...upstashAdapter.projectFields];
  const tierOf = (key: string) => all.find((f) => f.key === key)?.tier;

  test("the ping credential is server tier, because the sweep runs unattended", () => {
    assert.equal(tierOf("rest_token"), "server");
    assert.equal(tierOf("api_email"), "server");
    assert.equal(tierOf("api_key"), "server");
  });

  test("passwords a human reads are personal tier", () => {
    assert.equal(tierOf("account_password"), "personal");
    assert.equal(tierOf("db_password"), "personal");
  });

  test("the account email is not marked secret, so it can be shown", () => {
    assert.equal(all.find((f) => f.key === "api_email")?.secret, false);
    assert.equal(all.find((f) => f.key === "api_key")?.secret, true);
  });
});

describe("ping", () => {
  test("PONG is a successful keep-alive", async () => {
    const calls = stubFetch(() => new Response("PONG", { status: 200 }));
    const out = await upstashAdapter.ping!(project, { rest_token: "tok" });

    assert.equal(calls[0], `https://${ENDPOINT}/ping`);
    assert.equal(out.status, "ok");
    assert.equal(out.strategy, "ping");
    assert.equal(out.lifecycle, "active");
    assert.match(out.via!, /REST/);
  });

  test("works from the endpoint alone, with no management credentials", async () => {
    // Vercel- and Fly-created accounts have no Developer API, so the ping must not need one.
    stubFetch(() => json({ result: "PONG" }));
    const out = await upstashAdapter.ping!(
      { externalId: ENDPOINT, name: "cache", metadata: {} },
      { rest_token: "tok" },
    );
    assert.equal(out.status, "ok");
  });

  test("a rejected token does not by itself mean archived", async () => {
    // The regression guarded here is the Atlas one in another costume: a rotated token and an
    // archived database both produce a 401, and only the management API can tell them apart.
    // With no management key there is no verdict, so no lifecycle may be claimed.
    const calls = stubFetch(() => new Response("unauthorized", { status: 401 }));
    const out = await upstashAdapter.ping!(project, { rest_token: "stale" });

    assert.equal(out.status, "error");
    assert.equal(out.lifecycle, undefined);
    assert.equal(calls.length, 1, "should not have called the management API without a key");
    assert.match(out.error!, /rotated|archived/i);
  });

  test("with a management key, the archive is confirmed rather than guessed", async () => {
    stubFetch((url) =>
      url.includes("api.upstash.com")
        ? json({ database_id: ID, state: "passive" })
        : new Response("unauthorized", { status: 401 }),
    );
    const out = await upstashAdapter.ping!(project, {
      rest_token: "stale",
      api_email: "me@example.com",
      api_key: "k".repeat(40),
    });

    assert.equal(out.status, "error");
    assert.equal(out.lifecycle, "archived");
  });

  test("a missing token is an actionable error, not a request", async () => {
    const calls = stubFetch(() => json({ result: "PONG" }));
    const out = await upstashAdapter.ping!(project, {});

    assert.equal(calls.length, 0);
    assert.equal(out.status, "error");
    assert.match(out.error!, /REST token/i);
  });

  test("a missing endpoint says how to fix it", async () => {
    const out = await upstashAdapter.ping!(
      { externalId: ID, name: "cache", metadata: {} },
      { rest_token: "tok" },
    );
    assert.match(out.error!, /sync|endpoint host/i);
  });
});

describe("lifecycle mapping", () => {
  const creds = { api_email: "me@example.com", api_key: "k".repeat(40) };

  test("maps Upstash's state words", async () => {
    for (const [state, expected] of [
      ["active", "active"],
      ["passive", "archived"],
      ["suspended", "archived"],
      ["deleted", "deleted"],
    ] as const) {
      stubFetch(() => json({ database_id: ID, state }));
      const out = await upstashAdapter.status!(project, creds);
      assert.equal(out.lifecycle, expected, `state ${state}`);
      assert.equal(out.raw, state);
    }
  });

  test("an unrecognised state is unknown, not active", async () => {
    // Guessing "active" would hide a problem; guessing "archived" would invent one.
    stubFetch(() => json({ database_id: ID, state: "something_new" }));
    assert.equal((await upstashAdapter.status!(project, creds)).lifecycle, "unknown");
  });

  test("a 404 means deleted", async () => {
    stubFetch(() => new Response("not found", { status: 404 }));
    assert.equal((await upstashAdapter.status!(project, creds)).lifecycle, "deleted");
  });

  test("names the Vercel/Fly integration caveat on a 401", async () => {
    stubFetch(() => new Response("unauthorized", { status: 401 }));
    await assert.rejects(
      () => upstashAdapter.status!(project, creds),
      /Vercel or Fly/i,
    );
  });
});

describe("usage", () => {
  const creds = { api_email: "me@example.com", api_key: "k".repeat(40) };

  test("reads the monthly command budget the ping spends from", async () => {
    stubFetch(() =>
      json({
        total_monthly_requests: 12_345,
        total_monthly_bandwidth: 5_000_000,
        total_monthly_storage: 1_048_576,
      }),
    );
    const rows = await upstashAdapter.usage!(project, creds);
    const commands = rows.find((r) => r.metric === "commands")!;

    assert.equal(commands.value, 12_345);
    assert.equal(commands.limitValue, 500_000);
    assert.ok(commands.periodStart, "a monthly figure must carry its period");
  });

  test("prefers a limit the API reported over the published one", async () => {
    stubFetch(() => json({ total_monthly_requests: 10 }));
    const rows = await upstashAdapter.usage!(
      { ...project, metadata: { ...project.metadata, db_request_limit: 1_000_000 } },
      creds,
    );
    assert.equal(rows.find((r) => r.metric === "commands")!.limitValue, 1_000_000);
  });

  test("accepts numeric strings, which this endpoint has returned before", async () => {
    stubFetch(() => json({ total_monthly_requests: "250000" }));
    const rows = await upstashAdapter.usage!(project, creds);
    assert.equal(rows.find((r) => r.metric === "commands")!.value, 250_000);
  });

  test("storage carries no period, so no burn rate is projected from it", async () => {
    stubFetch(() => json({ total_monthly_storage: 1_000_000 }));
    const storage = (await upstashAdapter.usage!(project, creds)).find(
      (r) => r.metric === "storage_bytes",
    )!;
    assert.equal(storage.periodStart, null);

    // A point-in-time reading has no elapsed period, so headroom must decline to answer
    // rather than inventing "days until full" from a single number.
    const row: UsageRow = {
      id: 1,
      project_id: "p",
      metric: storage.metric,
      value: storage.value,
      limit_value: storage.limitValue,
      unit: storage.unit,
      period_start: storage.periodStart,
      period_end: storage.periodEnd,
      captured_at: new Date().toISOString(),
    };
    assert.equal(daysOfHeadroom(row), null);
  });

  test("reports nothing rather than inventing numbers when the shape changes", async () => {
    // The stats endpoint's field names have moved before. A meter with no number beats a
    // meter with a made-up one.
    stubFetch(() => json({ some_new_field_name: 123 }));
    await assert.rejects(() => upstashAdapter.usage!(project, creds), /no usage figures/i);
  });
});

describe("fetching the REST token", () => {
  const creds = { api_email: "me@example.com", api_key: "k".repeat(40) };

  test("stores the REST token and nothing else", async () => {
    stubFetch(() =>
      json({ database_id: ID, rest_token: "tok-123", password: "redis-pw", state: "active" }),
    );
    const fetched = await upstashAdapter.fetchProjectCredentials!(project, creds);

    // The Redis password is `personal` tier by design. Quietly storing it server-side so the
    // sweep could read it would break that promise without the user ever being asked.
    assert.deepEqual(Object.keys(fetched), ["rest_token"]);
    assert.equal(fetched.rest_token, "tok-123");
  });

  test("says to paste it when Upstash doesn't return one", async () => {
    // The published schema omits `rest_token`; this path is why the field is still editable.
    stubFetch(() => json({ database_id: ID, state: "active" }));
    await assert.rejects(
      () => upstashAdapter.fetchProjectCredentials!(project, creds),
      /UPSTASH_REDIS_REST_TOKEN/,
    );
  });
});

describe("connection strings", () => {
  test("uses Upstash's own env var names, not Prisma's", () => {
    // Labelling a rediss:// URL `DATABASE_URL` would send someone to paste it where their
    // Postgres client expects one.
    const out = upstashAdapter.connectionStrings!(project, { db_password: "pw" });
    assert.equal(out.labels?.pooled.name, "UPSTASH_REDIS_REST_URL");
    assert.equal(out.labels?.direct.name, "REDIS_URL");
  });

  test("the REST URL needs no password; the TCP URL does", () => {
    const withoutPassword = upstashAdapter.connectionStrings!(project, {});
    assert.equal(withoutPassword.pooled, `https://${ENDPOINT}`);
    assert.equal(withoutPassword.direct, null);

    const withPassword = upstashAdapter.connectionStrings!(project, { db_password: "pw" });
    assert.equal(withPassword.direct, `rediss://default:pw@${ENDPOINT}:6379`);
  });

  test("percent-encodes a password with URL-significant characters", () => {
    const out = upstashAdapter.connectionStrings!(project, { db_password: "p@ss/w#rd" });
    assert.ok(out.direct!.includes("p%40ss%2Fw%23rd"));
    assert.ok(!out.direct!.includes("p@ss"));
  });

  test("returns nothing when the endpoint isn't known, rather than guessing a host", () => {
    const out = upstashAdapter.connectionStrings!(
      { externalId: ID, name: "cache", metadata: {} },
      { db_password: "pw" },
    );
    assert.deepEqual([out.pooled, out.direct], [null, null]);
  });
});
