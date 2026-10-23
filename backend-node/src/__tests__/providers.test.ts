/**
 * Cross-provider tests: the properties that have to hold for *every* adapter.
 *
 * These are the ones that catch drift between a provider and the rest of the app, which is
 * where this project's real bugs have come from — not from the adapters themselves.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { activeProviders, getProvider, parseIdentifier, isImplemented } from "../providers/registry";
import { PROVIDER_IDS } from "../providers/types";
import { knownSecretKinds, serverCredentialKinds } from "../vault/kinds";

const SAMPLES: Record<string, { input: string; provider: string }[]> = {
  supabase: [
    { input: "https://abcdefghijklmnopqrst.supabase.co", provider: "supabase" },
    { input: "abcdefghijklmnopqrst", provider: "supabase" },
  ],
  neon: [
    { input: "https://console.neon.tech/app/projects/fragrant-dew-12345678", provider: "neon" },
    {
      input:
        "postgresql://neondb_owner:pw@ep-fragrant-dew-12345678.eu-central-1.aws.neon.tech/neondb",
      provider: "neon",
    },
  ],
  mongodb: [
    { input: "mongodb+srv://u:p@cluster0.ab12c.mongodb.net/", provider: "mongodb" },
    { input: "507f1f77bcf86cd799439011/Cluster0", provider: "mongodb" },
  ],
  upstash: [
    { input: "https://eu1-fancy-cat-12345.upstash.io", provider: "upstash" },
    { input: "https://console.upstash.com/redis/3a4f1b2c-5d6e-4f70-8a9b-0c1d2e3f4a5b", provider: "upstash" },
  ],
};

describe("the registry", () => {
  test("every id in PROVIDER_IDS either has an adapter or is honestly reported as missing", () => {
    for (const id of PROVIDER_IDS) {
      if (isImplemented(id)) {
        assert.equal(getProvider(id).id, id);
      } else {
        // The error has to name what *is* available, because this is what a user sees if a
        // registry row references a provider this build doesn't ship.
        assert.throws(() => getProvider(id), /No adapter is registered/);
      }
    }
  });

  test("adapter ids match their map keys, so `getProvider` can't return the wrong one", () => {
    for (const adapter of activeProviders()) {
      assert.equal(getProvider(adapter.id).id, adapter.id);
    }
  });
});

describe("paste anything, from any provider", () => {
  for (const [provider, samples] of Object.entries(SAMPLES)) {
    if (!isImplemented(provider as never)) continue;
    for (const { input } of samples) {
      test(`${provider}: ${input.slice(0, 48)}`, () => {
        assert.equal(parseIdentifier(input)?.provider, provider);
      });
    }
  }

  test("no provider claims another provider's identifier", () => {
    // The search box runs every adapter's parse() in PROVIDER_IDS order, so an adapter that
    // is too eager would silently shadow the provider the identifier really belongs to.
    for (const [owner, samples] of Object.entries(SAMPLES)) {
      for (const { input } of samples) {
        for (const adapter of activeProviders()) {
          if (adapter.id === owner) continue;
          assert.equal(
            adapter.parse(input),
            null,
            `${adapter.id} claimed a ${owner} identifier: ${input}`,
          );
        }
      }
    }
  });

  test("gibberish resolves to nothing rather than the first adapter", () => {
    for (const input of ["", "   ", "hello world", "https://example.com", "1234"]) {
      assert.equal(parseIdentifier(input), null, input);
    }
  });
});

describe("every adapter is internally consistent", () => {
  for (const adapter of activeProviders()) {
    describe(adapter.name, () => {
      test("capability flags match the methods it actually implements", () => {
        // The UI renders from these flags. A flag that lies produces a button that fails, or
        // a feature that exists but is never offered.
        assert.equal(adapter.capabilities.ping, !!adapter.ping, "ping");
        assert.equal(adapter.capabilities.discover, !!adapter.discover, "discover");
        assert.equal(adapter.capabilities.watch, !!adapter.usage, "watch");
        assert.equal(adapter.capabilities.health, !!adapter.health, "health");
      });

      test("a watch-strategy provider is never pingable", () => {
        if (adapter.policy.strategy === "watch") {
          assert.equal(adapter.capabilities.ping, false);
          assert.equal(adapter.ping, undefined);
        }
      });

      test("an alert_only provider can read status, since that is all it does", () => {
        if (adapter.policy.strategy === "alert_only") {
          assert.ok(adapter.status, "alert_only needs a status read to be worth anything");
          assert.equal(adapter.capabilities.ping, false);
        }
      });

      test("the ping interval leaves margin inside the inactivity window", () => {
        const { pausesAfterDays, defaultIntervalDays, strategy } = adapter.policy;
        if (strategy !== "ping" || pausesAfterDays === null) return;
        /*
         * At least two days of slack. The cron runs once a day, so one day of margin would
         * mean a single failed run could let a project be paused — and the margins differ
         * legitimately per provider (Supabase 5-in-7, Atlas 20-in-30, Upstash 7-in-14)
         * because a connection costs more at some providers than others.
         */
        assert.ok(
          pausesAfterDays - defaultIntervalDays >= 2,
          `${adapter.id} pings every ${defaultIntervalDays}d inside a ${pausesAfterDays}d window`,
        );
      });

      test("credential fields are unique, labelled, and tiered", () => {
        const fields = [...adapter.accountFields, ...adapter.projectFields];
        const keys = fields.map((f) => f.key);
        assert.equal(new Set(keys).size, keys.length, "duplicate credential keys");

        for (const f of fields) {
          assert.ok(f.label.trim(), `${f.key} has no label`);
          // The help text is where the tier is explained, and every one of these fields is
          // something a user has to go and find in a provider console.
          assert.ok(f.help.trim().length > 30, `${f.key} needs real help text`);
          assert.ok(f.tier === "server" || f.tier === "personal", `${f.key} tier`);
        }
      });

      test("a login password is personal tier in every provider", () => {
        const field = adapter.accountFields.find((f) => f.key === "account_password");
        if (field) assert.equal(field.tier, "personal", "a human's password is never server tier");
      });

      test("its policy summary says something substantive", () => {
        // This string is the UI's explanation of the whole keep-alive model for a provider.
        assert.ok(adapter.policy.summary.length > 80);
        assert.ok(adapter.policy.docsUrl.startsWith("https://"));
      });
    });
  }
});

describe("the vault accepts every credential an adapter asks for", () => {
  test("no adapter declares a field the vault would reject", () => {
    /*
     * The bug this exists for: `app/vault/actions.ts` kept a hand-written list of secret
     * kinds, and it fell behind the adapters. Atlas declares `sa_client_id` and
     * `sa_client_secret`, neither of which was on the list, so saving an Atlas service
     * account failed with "Unknown secret type." — which made Atlas discovery, the entire
     * point of that adapter, unreachable through the UI.
     */
    const known = knownSecretKinds();
    for (const adapter of activeProviders()) {
      for (const field of [...adapter.accountFields, ...adapter.projectFields]) {
        assert.ok(
          known.has(field.key),
          `${adapter.id} asks for "${field.key}", which the vault would refuse to store`,
        );
      }
    }
  });

  test("and accepts nothing else", () => {
    // The reverse direction: a kind nothing asks for is a kind nothing can read back.
    const declared = new Set(
      activeProviders().flatMap((a) =>
        [...a.accountFields, ...a.projectFields].map((f) => f.key),
      ),
    );
    for (const kind of knownSecretKinds()) {
      assert.ok(declared.has(kind), `the vault accepts "${kind}" but no provider asks for it`);
    }
  });
});

describe("the 'missing credentials' badge asks the adapter, not one hard-coded kind", () => {
  /*
   * The bug this exists for: `projectIdsWithStoredKey` looked for `kind: "anon_key"`, which
   * only Supabase declares. A MongoDB Atlas project with a working `connection_string` was
   * therefore reported as "missing credentials" on the dashboard forever, while the nightly
   * sweep — which resolves credentials by owner and tier, not by kind — pinged it fine. The
   * badge and the sweep have to agree on what "has credentials" means.
   */
  test("every pingable adapter has at least one server-tier kind to be found by", () => {
    for (const adapter of activeProviders()) {
      if (adapter.policy.strategy !== "ping") continue;
      assert.ok(
        serverCredentialKinds(adapter.id).size > 0,
        `${adapter.id} can be pinged but declares no server-tier credential, so the sweep could never authenticate for it`,
      );
    }
  });

  test("the kinds come from the adapter, so they differ between providers", () => {
    // The guard against the hard-coded kind creeping back: if every provider resolved to the
    // same set, a single literal would still pass the test above.
    const perProvider = activeProviders()
      .filter((a) => a.policy.strategy === "ping")
      .map((a) => [...serverCredentialKinds(a.id)].sort().join(","));
    assert.ok(
      new Set(perProvider).size > 1,
      "every provider reported the same credential kinds — that is the hard-coded-kind bug returning",
    );
  });

  test("a personal-tier field never counts, because the sweep cannot decrypt one", () => {
    // `resolveServerCredentials` skips personal rows by design, so counting one would make
    // the badge claim a project is covered when the nightly sweep has nothing to use.
    for (const adapter of activeProviders()) {
      const usable = serverCredentialKinds(adapter.id);
      for (const field of [...adapter.accountFields, ...adapter.projectFields]) {
        if (field.tier !== "personal") continue;
        assert.ok(
          !usable.has(field.key),
          `${adapter.id} counts personal-tier "${field.key}" as a sweep credential`,
        );
      }
    }
  });

  test("an unimplemented provider resolves to nothing rather than throwing", () => {
    assert.equal(serverCredentialKinds("appwrite").size, 0);
    assert.equal(serverCredentialKinds("not-a-provider").size, 0);
  });
});
