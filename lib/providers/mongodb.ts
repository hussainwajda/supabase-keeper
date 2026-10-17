import type {
  AccountOverview,
  ConnectionStrings,
  CredentialField,
  Credentials,
  Discovered,
  Lifecycle,
  ParsedIdentifier,
  PingOutcome,
  ProjectRef,
  ProviderAdapter,
  UsageSnapshot,
} from "./types";

const BASE = "https://cloud.mongodb.com";

/**
 * Atlas versions its API **per resource**, and a request with a missing or unknown version
 * gets a 406 rather than a default. The current docs use `2025-03-12`, so that is the pin;
 * on a 406 we walk back through older stable dates rather than failing, because an endpoint
 * we touch may not have been revised as recently.
 */
const API_VERSIONS = ["2025-03-12", "2024-08-05", "2023-02-01", "2023-01-01"] as const;

/** The version that last worked, so the fallback walk is paid once per process, not per call. */
let preferredVersion: string = API_VERSIONS[0];

type ApiResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: string };

/**
 * Exchange a service account's client ID and secret for a bearer token.
 *
 * Service accounts over the legacy programmatic API keys for one decisive reason: those keys
 * require HTTP **Digest** auth, which `fetch` does not implement — supporting them would mean
 * hand-rolling an MD5 challenge/response in a credential path. OAuth client-credentials is a
 * single POST.
 *
 * Tokens last an hour. Cached per client id, with a minute of slack, so a sweep across many
 * clusters doesn't re-authenticate for each one.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(clientId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${BASE}/api/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });

  const body = (await res.text()).slice(0, 300);
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        "Atlas rejected the service account credentials. Check the client ID and secret, and that the service account hasn't expired — Atlas secrets have an expiry date.",
      );
    }
    throw new Error(`Atlas OAuth failed (${res.status}): ${body}`);
  }

  const parsed = JSON.parse(body) as { access_token?: string; expires_in?: number };
  if (!parsed.access_token) throw new Error("Atlas returned no access token.");

  tokenCache.set(clientId, {
    token: parsed.access_token,
    expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
  });
  return parsed.access_token;
}

async function api(credentials: Credentials, path: string): Promise<ApiResult> {
  const clientId = credentials.sa_client_id;
  const clientSecret = credentials.sa_client_secret;
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      status: 0,
      error: "An Atlas service account (client ID and secret) is required.",
    };
  }

  let token: string;
  try {
    token = await accessToken(clientId, clientSecret);
  } catch (e) {
    return { ok: false, status: 401, error: (e as Error).message };
  }

  // Try the remembered version first, then the rest — a 406 means this resource doesn't
  // publish that date.
  const order = [preferredVersion, ...API_VERSIONS.filter((v) => v !== preferredVersion)];

  for (const version of order) {
    try {
      const res = await fetch(`${BASE}/api/atlas/v2${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: `application/vnd.atlas.${version}+json`,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });

      if (res.status === 406) continue;

      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        const error =
          res.status === 401
            ? "Atlas rejected the token. The service account must belong to the organization that owns this project, and its IP access list must allow this server."
            : res.status === 403
              ? "The service account lacks permission for this resource. Organization Read Only is enough for Keepstack."
              : `Atlas API ${res.status}: ${body || res.statusText}`;
        return { ok: false, status: res.status, error };
      }

      preferredVersion = version;
      const text = await res.text();
      return { ok: true, data: text ? JSON.parse(text) : null };
    } catch (e) {
      return { ok: false, status: 0, error: (e as Error).message };
    }
  }

  return {
    ok: false,
    status: 406,
    error: `Atlas rejected every API version Keepstack knows (${API_VERSIONS.join(", ")}) for ${path}. The endpoint has probably been revised — update API_VERSIONS in lib/providers/mongodb.ts.`,
  };
}

/**
 * Identity. A cluster is only unique inside its project (Atlas calls a project a "group"),
 * and a user with several free clusters usually has several projects each holding a
 * `Cluster0` — so the external id has to carry both parts.
 */
export function atlasExternalId(groupId: string, clusterName: string): string {
  return `${groupId}/${clusterName}`;
}

export function splitAtlasId(externalId: string): { groupId: string; clusterName: string } | null {
  const slash = externalId.indexOf("/");
  if (slash <= 0) return null;
  return {
    groupId: externalId.slice(0, slash),
    clusterName: externalId.slice(slash + 1),
  };
}

/**
 * `paused` is the field that matters, not `stateName`.
 *
 * A paused cluster can still report `stateName: "IDLE"` — users have reported exactly that
 * confusion — so branching on the state name alone would miss the one condition Keepstack
 * exists to catch.
 */
function lifecycleFromCluster(cluster: { paused?: boolean; stateName?: string }): Lifecycle {
  if (cluster.paused === true) return "paused";
  switch (cluster.stateName) {
    case "IDLE":
      return "active";
    case "CREATING":
    case "UPDATING":
    case "REPAIRING":
      return "idle";
    case "DELETED":
      return "deleted";
    default:
      return cluster.paused === false ? "active" : "unknown";
  }
}

const accountFields: CredentialField[] = [
  {
    key: "sa_client_id",
    label: "Service account client ID",
    help: "Atlas → Organization Access Manager → Applications → Service Accounts. Organization Read Only is enough. Service accounts are used rather than legacy API keys because those need HTTP Digest auth, which isn't available here.",
    secret: false,
    required: false,
    tier: "server",
    placeholder: "mdb_sa_id_...",
  },
  {
    key: "sa_client_secret",
    label: "Service account secret",
    help: "Shown once when the service account is created. Atlas secrets expire — note the date, because discovery will start failing when it lapses.",
    secret: true,
    required: false,
    tier: "server",
    placeholder: "mdb_sa_sk_...",
  },
  {
    key: "account_password",
    label: "Account login password",
    help: "Only if you sign into Atlas with email + password. Encrypted with your PIN — the server can't read it unattended.",
    secret: true,
    required: false,
    tier: "personal",
  },
];

const projectFields: CredentialField[] = [
  {
    key: "connection_string",
    label: "Keep-alive connection string",
    help: "An SRV string for a dedicated read-only user, e.g. mongodb+srv://keepstack-ping:PASSWORD@cluster0.ab12c.mongodb.net/. SERVER TIER: the nightly sweep opens a real driver connection with it, so the server must be able to read it unattended. Leave blank and Atlas degrades to alerts-only — Keepstack still detects a pause, it just can't prevent one.",
    secret: true,
    required: false,
    tier: "server",
    placeholder: "mongodb+srv://keepstack-ping:…@cluster0.ab12c.mongodb.net/",
    validate: (v) =>
      v.startsWith("mongodb+srv://") || v.startsWith("mongodb://")
        ? null
        : "That should be a mongodb+srv:// (or mongodb://) connection string.",
  },
  {
    key: "db_password",
    label: "Application database password",
    help: "The password your app uses, kept here for reference. Encrypted with your PIN, and never used by the sweep.",
    secret: true,
    required: false,
    tier: "personal",
  },
];

export const mongodbAdapter: ProviderAdapter = {
  id: "mongodb",
  name: "MongoDB Atlas",
  accentVar: "--color-provider-mongodb",

  capabilities: {
    discover: true,
    ping: true,
    watch: false,
    // M0 can be *created* through the Clusters API but not modified, and `paused: false` is
    // an M10+ operation — so there is no API path back from a free-tier pause.
    revive: false,
    health: false,
    rotate: false,
  },

  policy: {
    strategy: "ping",
    pausesAfterDays: 30,
    deletesAfterDays: null,
    pauseNoun: "paused",
    // 30-day window, so 20 days leaves a third of it as margin while keeping connections rare.
    defaultIntervalDays: 20,
    summary:
      "Atlas pauses a free (M0) cluster after 30 days with zero connections, warning by email 7 days before. Your data is kept and you can resume from the console — but not through the API, because free clusters can't be modified that way. Keeping one alive needs a real driver connection: the Atlas Data API was removed in September 2025, so there is no HTTP query path left.",
    docsUrl: "https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/",
  },

  accountFields,
  projectFields,

  parse(input: string): ParsedIdentifier | null {
    const s = input.trim();

    // A full external id, as discovery stores it.
    if (/^[a-f0-9]{24}\/.+$/i.test(s)) {
      return { externalId: s, hint: "project and cluster" };
    }

    // An SRV connection string or bare host: cluster0.ab12c.mongodb.net. The host is unique
    // per Atlas project, so it identifies a cluster even though it carries no group id —
    // the registry matches it against the stored `srv_host`.
    const host = s.match(/([a-z0-9-]+)\.([a-z0-9]+)\.mongodb\.net/i);
    if (host) return { externalId: host[0].toLowerCase(), hint: "connection string" };

    // A console URL: .../v2/<groupId>#/clusters/detail/<clusterName>
    const console_ = s.match(/\/v2\/([a-f0-9]{24}).*?\/clusters\/(?:detail\/)?([A-Za-z0-9_-]+)/i);
    if (console_) {
      return { externalId: atlasExternalId(console_[1], console_[2]), hint: "console URL" };
    }

    // A bare project (group) id on its own is not a cluster, so it is not an identifier here.
    return null;
  },

  consoleUrl: (project) => {
    const parts = splitAtlasId(project.externalId);
    if (!parts) return "https://cloud.mongodb.com/";
    return `${BASE}/v2/${parts.groupId}#/clusters/detail/${encodeURIComponent(parts.clusterName)}`;
  },

  /** Organisations → projects (groups) → clusters. Three levels, so three round trips. */
  async discover(credentials: Credentials): Promise<Discovered[]> {
    const orgsRes = await api(credentials, "/orgs");
    if (!orgsRes.ok) throw new Error(orgsRes.error);

    const orgs = ((orgsRes.data as { results?: unknown[] })?.results ?? []) as {
      id: string;
      name: string;
    }[];

    const found: Discovered[] = [];

    for (const org of orgs) {
      const groupsRes = await api(credentials, `/orgs/${org.id}/groups`);
      if (!groupsRes.ok) continue;

      const groups = ((groupsRes.data as { results?: unknown[] })?.results ?? []) as {
        id: string;
        name: string;
      }[];

      for (const group of groups) {
        const clustersRes = await api(credentials, `/groups/${group.id}/clusters`);
        if (!clustersRes.ok) continue;

        const clusters = ((clustersRes.data as { results?: unknown[] })?.results ?? []) as {
          name: string;
          paused?: boolean;
          stateName?: string;
          mongoDBVersion?: string;
          createDate?: string;
          clusterType?: string;
          replicationSpecs?: { regionConfigs?: { regionName?: string; providerName?: string; electableSpecs?: { instanceSize?: string } }[] }[];
          connectionStrings?: { standardSrv?: string; standard?: string };
        }[];

        for (const cluster of clusters) {
          const region = cluster.replicationSpecs?.[0]?.regionConfigs?.[0];
          const srv = cluster.connectionStrings?.standardSrv ?? null;

          found.push({
            externalId: atlasExternalId(group.id, cluster.name),
            name: cluster.name,
            region: region?.regionName ?? null,
            plan: region?.electableSpecs?.instanceSize ?? null,
            providerStatus: cluster.paused ? "PAUSED" : (cluster.stateName ?? null),
            lifecycle: lifecycleFromCluster(cluster),
            createdAt: cluster.createDate ?? null,
            metadata: {
              org_id: org.id,
              org_name: org.name,
              group_id: group.id,
              group_name: group.name,
              cluster_name: cluster.name,
              mongo_version: cluster.mongoDBVersion ?? null,
              cluster_type: cluster.clusterType ?? null,
              cloud_provider: region?.providerName ?? null,
              instance_size: region?.electableSpecs?.instanceSize ?? null,
              // Stored so a pasted SRV string can be matched back to this cluster.
              srv_host: srv ? srv.replace(/^mongodb\+srv:\/\//, "").split("/")[0] : null,
              srv: srv,
            },
          });
        }
      }
    }

    return found;
  },

  async status(project: ProjectRef, credentials: Credentials) {
    const parts = splitAtlasId(project.externalId);
    if (!parts) throw new Error("This project's Atlas identifier is malformed. Re-run a sync.");

    const res = await api(
      credentials,
      `/groups/${parts.groupId}/clusters/${encodeURIComponent(parts.clusterName)}`,
    );
    if (!res.ok) {
      if (res.status === 404) return { lifecycle: "deleted" as Lifecycle, raw: "NOT_FOUND" };
      throw new Error(res.error);
    }

    const cluster = res.data as { paused?: boolean; stateName?: string };
    return {
      lifecycle: lifecycleFromCluster(cluster),
      raw: cluster.paused ? "PAUSED" : (cluster.stateName ?? "UNKNOWN"),
    };
  },

  /**
   * Keep the cluster alive with a real driver connection.
   *
   * There is no lighter option: the Atlas Data API and custom HTTPS endpoints were removed on
   * 30 September 2025, so an HTTP request can't reach the database any more. Atlas counts
   * *connections*, which is exactly what this opens — and then closes, every time.
   *
   * Without a stored connection string this degrades to a status read: Keepstack still sees
   * the pause and still warns, it just can't prevent one. That is reported honestly as
   * `alert_only`, never as a successful keep-alive.
   */
  async ping(project: ProjectRef, credentials: Credentials): Promise<PingOutcome> {
    const started = Date.now();
    const uri = credentials.connection_string;

    if (!uri) {
      // Degrade to a status check rather than claiming a failure or a success.
      try {
        const { lifecycle, raw } = await this.status!(project, credentials);
        const paused = lifecycle === "paused";
        return {
          status: paused ? "error" : "ok",
          strategy: "alert_only",
          httpStatus: null,
          durationMs: Date.now() - started,
          error: paused
            ? "Cluster is PAUSED — resume it from the Atlas console. Free clusters can't be resumed through the API."
            : null,
          lifecycle,
          via: `status check only (${raw}) — no connection string stored, so nothing reset the inactivity clock`,
        };
      } catch (e) {
        return {
          status: "error",
          strategy: "alert_only",
          httpStatus: null,
          durationMs: Date.now() - started,
          error: (e as Error).message,
          via: "status check only",
        };
      }
    }

    // Dynamic import keeps the driver out of every other bundle; it only loads when a Mongo
    // cluster is actually pinged.
    const { MongoClient } = await import("mongodb");

    const client = new MongoClient(uri, {
      // Short and explicit: a hanging connection is the easy way to blow the cron's
      // 60-second budget, and a paused cluster is precisely the case that hangs.
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      socketTimeoutMS: 10_000,
      // One connection, held for as long as the ping takes and no longer. M0 allows 500, but
      // there is no reason to use more than one.
      maxPoolSize: 1,
      appName: "keepstack",
      retryWrites: false,
    });

    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      return {
        status: "ok",
        strategy: "ping",
        httpStatus: null,
        durationMs: Date.now() - started,
        error: null,
        lifecycle: "active",
        via: "driver connection + admin ping",
      };
    } catch (e) {
      const message = (e as Error).message;
      let error = message;

      // A socket failure has several possible causes and the driver can't tell them apart,
      // so none of them is reported as a lifecycle. `status()` below is the authority.
      if (/ENOTFOUND|getaddrinfo|querySrv/i.test(message)) {
        error = `That hostname doesn't resolve. Check the connection string — an SRV host looks like cluster0.ab12c.mongodb.net. ${message}`;
      } else if (/server selection timed out|ETIMEDOUT|connection timed out/i.test(message)) {
        error = `Couldn't reach the cluster before the timeout. Either it is paused, or this server's IP isn't on the cluster's Network Access list — a serverless host needs 0.0.0.0/0. ${message}`;
      } else if (/authentication failed|bad auth/i.test(message)) {
        error = `Authentication failed. Check the keep-alive user's username and password, and that the password is URL-encoded in the connection string. ${message}`;
      } else if (/not authorized/i.test(message)) {
        error = `The keep-alive user can't run an admin ping. Give it readAnyDatabase, or point the string at a database it can read. ${message}`;
      }

      /*
       * Ask Atlas what is actually going on.
       *
       * A failed connection could mean paused, an IP that isn't allowlisted, a wrong
       * password or a typo in the host — and guessing "paused" from a socket error would
       * put a red paused banner on a project whose only problem is a firewall rule. The
       * Admin API reports `paused` definitively, so one extra call on the failure path buys
       * a correct answer instead of a plausible one.
       */
      let lifecycle: Lifecycle | undefined;
      if (credentials.sa_client_id && credentials.sa_client_secret) {
        try {
          const confirmed = await this.status!(project, credentials);
          lifecycle = confirmed.lifecycle;
          if (confirmed.lifecycle === "paused") {
            error = `Cluster is PAUSED — resume it from the Atlas console. Free clusters can't be resumed through the API. ${error}`;
          }
        } catch {
          // No verdict available; leave the stored lifecycle untouched rather than overwrite
          // it with a guess.
        }
      }

      return {
        status: "error",
        strategy: "ping",
        httpStatus: null,
        durationMs: Date.now() - started,
        error,
        ...(lifecycle ? { lifecycle } : {}),
        via: "driver connection",
      };
    } finally {
      // Always, even on failure: a leaked connection on an M0 counts against its 500 cap.
      await client.close().catch(() => {});
    }
  },

  /** Atlas reports no usage figures for M0, but its hard limits are worth showing. */
  async usage(project: ProjectRef): Promise<UsageSnapshot[]> {
    const size = project.metadata.instance_size as string | undefined;
    if (size !== "M0") return [];

    // Static plan limits rather than measured consumption — Atlas publishes no per-cluster
    // usage for the free tier, and a card of invented numbers would be worse than none.
    return [
      {
        metric: "storage_bytes",
        value: 0,
        limitValue: 0.5 * 1024 ** 3,
        unit: "bytes",
        periodStart: null,
        periodEnd: null,
      },
    ];
  },

  async overview(credentials: Credentials): Promise<AccountOverview> {
    const clusters = await this.discover!(credentials);
    const byOrg = new Map<string, { name: string; count: number }>();

    for (const c of clusters) {
      const id = (c.metadata.org_id as string) ?? "unknown";
      const name = (c.metadata.org_name as string) ?? "Organization";
      const entry = byOrg.get(id) ?? { name, count: 0 };
      entry.count++;
      byOrg.set(id, entry);
    }

    return {
      organizations: [...byOrg].map(([id, { name, count }]) => ({
        id,
        name,
        plan: null,
        projectCount: count,
        // The free-tier rule is one M0 per *project*, not per organization, so an org-level
        // allowance would be a made-up number.
        freeProjectLimit: null,
      })),
    };
  },

  connectionStrings(project: ProjectRef, secrets: Record<string, string>): ConnectionStrings {
    const stored = secrets.connection_string;
    if (stored) return { pooled: stored, direct: stored };

    const srv = project.metadata.srv as string | undefined;
    const password = secrets.db_password;
    if (!srv || !password) return { pooled: null, direct: null };

    // Insert credentials into the discovered SRV string. The username isn't knowable from
    // the API, so it stays a placeholder rather than a guess.
    const encoded = encodeURIComponent(password);
    const withAuth = srv.replace("mongodb+srv://", `mongodb+srv://<username>:${encoded}@`);
    return { pooled: withAuth, direct: withAuth };
  },
};
