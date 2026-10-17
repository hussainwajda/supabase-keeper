/**
 * MongoDB Atlas adapter unit tests. Run with: pnpm test
 *
 * Pure logic only. The OAuth and driver paths are exercised by hand; see docs/ROADMAP.md.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mongodbAdapter, atlasExternalId, splitAtlasId } from "../mongodb";
import { parseIdentifier } from "../registry";
import { mapWithLimit, mapWithDeadline } from "../../concurrency";

const GROUP = "507f1f77bcf86cd799439011";
const CLUSTER = "Cluster0";
const ID = `${GROUP}/${CLUSTER}`;

describe("identity", () => {
  test("round-trips a group and cluster", () => {
    assert.equal(atlasExternalId(GROUP, CLUSTER), ID);
    assert.deepEqual(splitAtlasId(ID), { groupId: GROUP, clusterName: CLUSTER });
  });

  test("keeps the group id, because cluster names collide across projects", () => {
    // A user with three free clusters usually has three Atlas projects, each with a
    // `Cluster0`. Identifying by name alone would merge them.
    assert.notEqual(atlasExternalId("aaa", CLUSTER), atlasExternalId("bbb", CLUSTER));
  });

  test("handles a cluster name containing a slash-free hyphen", () => {
    assert.deepEqual(splitAtlasId(`${GROUP}/my-cluster-1`), {
      groupId: GROUP,
      clusterName: "my-cluster-1",
    });
  });

  test("rejects malformed ids instead of guessing", () => {
    assert.equal(splitAtlasId("no-slash-here"), null);
    assert.equal(splitAtlasId("/leading"), null);
    assert.equal(splitAtlasId(""), null);
  });
});

describe("identifier parsing", () => {
  test("accepts a full project/cluster id", () => {
    assert.deepEqual(mongodbAdapter.parse(ID), { externalId: ID, hint: "project and cluster" });
  });

  test("pulls the host out of an SRV connection string", () => {
    const uri = `mongodb+srv://user:pw@cluster0.ab12c.mongodb.net/mydb?retryWrites=true`;
    assert.deepEqual(mongodbAdapter.parse(uri), {
      externalId: "cluster0.ab12c.mongodb.net",
      hint: "connection string",
    });
  });

  test("accepts a bare SRV host", () => {
    assert.equal(
      mongodbAdapter.parse("cluster0.ab12c.mongodb.net")?.externalId,
      "cluster0.ab12c.mongodb.net",
    );
  });

  test("pulls both parts out of a console URL", () => {
    const url = `https://cloud.mongodb.com/v2/${GROUP}#/clusters/detail/${CLUSTER}`;
    assert.equal(mongodbAdapter.parse(url)?.externalId, ID);
  });

  test("a bare project id is not a cluster identifier", () => {
    // It names a project, not a cluster — accepting it would create a row that can never be
    // pinged or resolved.
    assert.equal(mongodbAdapter.parse(GROUP), null);
  });

  test("rejects other providers' identifiers", () => {
    assert.equal(mongodbAdapter.parse("abcdefghijklmnopqrst"), null);
    assert.equal(mongodbAdapter.parse("fragrant-dew-12345678"), null);
  });

  test("the registry keeps all three providers' identifiers distinct", () => {
    assert.equal(parseIdentifier("https://abcdefghijklmnopqrst.supabase.co")?.provider, "supabase");
    assert.equal(parseIdentifier("https://console.neon.tech/app/projects/fragrant-dew-12345678")?.provider, "neon");
    assert.equal(parseIdentifier("mongodb+srv://u:p@cluster0.ab12c.mongodb.net/")?.provider, "mongodb");
  });

  test("the console URL points at the right cluster, and degrades safely", () => {
    const url = mongodbAdapter.consoleUrl({ externalId: ID, name: CLUSTER, metadata: {} });
    assert.ok(url.includes(GROUP));
    assert.ok(url.includes(CLUSTER));
    // A row registered from an SRV paste has no group id; a root link beats a broken one.
    assert.equal(
      mongodbAdapter.consoleUrl({ externalId: "cluster0.ab12c.mongodb.net", name: "x", metadata: {} }),
      "https://cloud.mongodb.com/",
    );
  });
});

describe("policy", () => {
  test("describes the real M0 rule", () => {
    assert.equal(mongodbAdapter.policy.strategy, "ping");
    assert.equal(mongodbAdapter.policy.pausesAfterDays, 30);
    // Atlas keeps paused data; a deletion countdown would be a lie.
    assert.equal(mongodbAdapter.policy.deletesAfterDays, null);
  });

  test("the default interval leaves real margin inside 30 days", () => {
    assert.ok(mongodbAdapter.policy.defaultIntervalDays <= 20);
    assert.ok(mongodbAdapter.policy.defaultIntervalDays >= 7, "needlessly frequent connections");
  });

  test("does not claim it can revive a free cluster", () => {
    // M0 can be created but not modified through the Clusters API, and `paused: false` is an
    // M10+ operation. Claiming otherwise would put a button there that always fails.
    assert.equal(mongodbAdapter.capabilities.revive, false);
    assert.equal(mongodbAdapter.revive, undefined);
  });

  test("explains why a driver connection is needed", () => {
    assert.match(mongodbAdapter.policy.summary, /Data API was removed/i);
  });
});

describe("credential tiers", () => {
  test("the keep-alive connection string must be server tier", () => {
    // The honest exception in the two-tier model: the sweep opens the connection itself, so
    // this one password has to be machine-readable. docs/SECURITY.md §1 says so out loud.
    const field = mongodbAdapter.projectFields.find((f) => f.key === "connection_string")!;
    assert.equal(field.tier, "server");
    assert.match(field.help, /SERVER TIER/);
    assert.match(field.help, /read-only/i);
  });

  test("the application password stays personal", () => {
    assert.equal(mongodbAdapter.projectFields.find((f) => f.key === "db_password")!.tier, "personal");
  });

  test("validates the connection string's scheme", () => {
    const v = mongodbAdapter.projectFields.find((f) => f.key === "connection_string")!.validate!;
    assert.equal(v("mongodb+srv://u:p@host/"), null);
    assert.equal(v("mongodb://u:p@host/"), null);
    assert.ok(v("postgresql://u:p@host/"));
    assert.ok(v("cluster0.ab12c.mongodb.net"));
  });
});

describe("connection strings", () => {
  test("a stored string is returned as-is", () => {
    const uri = "mongodb+srv://u:p@cluster0.ab12c.mongodb.net/";
    const out = mongodbAdapter.connectionStrings!({ externalId: ID, name: "x", metadata: {} }, {
      connection_string: uri,
    });
    assert.equal(out.pooled, uri);
    assert.equal(out.direct, uri);
  });

  test("percent-encodes a password injected into a discovered SRV string", () => {
    const out = mongodbAdapter.connectionStrings!(
      { externalId: ID, name: "x", metadata: { srv: "mongodb+srv://cluster0.ab12c.mongodb.net" } },
      { db_password: "p@ss/word" },
    );
    assert.ok(out.pooled!.includes(encodeURIComponent("p@ss/word")));
    // The username isn't knowable from the API, so it stays an obvious placeholder.
    assert.ok(out.pooled!.includes("<username>"));
  });

  test("returns nothing without a host or a password", () => {
    assert.deepEqual(
      mongodbAdapter.connectionStrings!({ externalId: ID, name: "x", metadata: {} }, {}),
      { pooled: null, direct: null },
    );
  });
});

describe("driver ping failure handling", () => {
  const project = { externalId: ID, name: CLUSTER, metadata: {} };

  test("a DNS failure is not reported as a pause", async () => {
    // The regression this guards: inferring "paused" from any socket error would put a red
    // paused banner on a project whose only problem is a typo or a firewall rule. Only the
    // Admin API's `paused` field may set that, so with no service account the lifecycle is
    // left untouched.
    const out = await mongodbAdapter.ping!(project, {
      connection_string: "mongodb+srv://u:p@cluster0.invalid-host-xyz.mongodb.net/",
    });
    assert.equal(out.status, "error");
    assert.equal(out.lifecycle, undefined);
    assert.match(out.error!, /doesn't resolve/i);
    assert.equal(out.strategy, "ping");
  });

  test("a missing connection string degrades to alert_only, never a false success", async () => {
    const out = await mongodbAdapter.ping!(project, {});
    // The honesty rule: no connection was opened, so nothing reset the inactivity clock and
    // the record must not say "ping".
    assert.equal(out.strategy, "alert_only");
    assert.match(out.via!, /status check only/i);
  });

  test("the driver ping stays inside the sweep's budget", async () => {
    const started = Date.now();
    await mongodbAdapter.ping!(project, {
      connection_string: "mongodb+srv://u:p@cluster0.invalid-host-xyz.mongodb.net/",
    });
    // Timeouts are pinned at 8s; anything near 30 would blow the cron's 60s budget.
    assert.ok(Date.now() - started < 15_000, "ping took too long to fail");
  });
});

describe("sweep concurrency", () => {
  test("never exceeds the limit in flight", async () => {
    let active = 0;
    let peak = 0;
    await mapWithLimit(Array.from({ length: 20 }, (_, i) => i), 3, async (i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return i;
    });
    assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  });

  test("preserves input order in the results", async () => {
    const out = await mapWithLimit([1, 2, 3, 4, 5], 2, async (n) => {
      await new Promise((r) => setTimeout(r, (6 - n) * 4));
      return n * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
  });

  test("stops starting work past the deadline and reports the rest as skipped", async () => {
    const { results, skipped } = await mapWithDeadline(
      Array.from({ length: 10 }, (_, i) => i),
      1,
      40,
      async (i) => {
        await new Promise((r) => setTimeout(r, 15));
        return i;
      },
    );
    // Some ran, some didn't, and nothing vanished.
    assert.ok(results.length > 0, "nothing ran");
    assert.ok(skipped.length > 0, "deadline never engaged");
    assert.equal(results.length + skipped.length, 10);
  });

  test("an empty list is a no-op", async () => {
    assert.deepEqual(await mapWithLimit([], 4, async () => 1), []);
  });
});
