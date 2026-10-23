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

const API = "https://api.upstash.com/v2";

/**
 * Upstash's free Redis quotas, per month. Only used when the API doesn't report a limit of
 * its own — the database object carries several `db_*` thresholds, and a reported figure is
 * always preferred to a published one.
 */
const FREE_LIMITS = {
  commands: 500_000,
  bandwidthBytes: 10 * 1024 ** 3,
  storageBytes: 256 * 1024 ** 2,
} as const;

/**
 * The Developer API takes HTTP Basic auth with the **account email as the username** and the
 * Developer API key as the password. Two credentials, which is why `api_email` is a stored
 * field rather than being read from the Keepstack account row: the Upstash login is often a
 * different address from the one you sign into Keepstack with.
 */
async function api(
  credentials: Credentials,
  path: string,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const email = credentials.api_email;
  const key = credentials.api_key;
  if (!email || !key) {
    return {
      ok: false,
      status: 0,
      error:
        "Upstash needs both the account email and a Developer API key. Add them under this account's Credentials.",
    };
  }

  const basic = Buffer.from(`${email}:${key}`).toString("base64");
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const error =
        res.status === 401 || res.status === 403
          ? // The single most common cause, and invisible from the error itself: accounts
            // created through the Vercel or Fly.io integrations have no Developer API.
            "Upstash rejected the email and API key. Check both — and note that accounts created through the Vercel or Fly.io integrations can't use the Developer API at all."
          : res.status === 404
            ? "Upstash doesn't have that database. It may have been deleted, or belong to another account."
            : `Upstash API ${res.status}: ${body || res.statusText}`;
      return { ok: false, status: res.status, error };
    }

    const text = await res.text();
    return { ok: true, data: text ? JSON.parse(text) : null };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

/** What the Developer API returns for a database. Everything optional: see `usage()`. */
type UpstashDatabase = {
  database_id: string;
  database_name?: string;
  database_type?: string;
  region?: string;
  type?: string;
  port?: number;
  creation_time?: number;
  state?: string;
  endpoint?: string;
  tls?: boolean;
  rest_token?: string;
  read_only_rest_token?: string;
  password?: string;
  db_disk_threshold?: number;
  db_memory_threshold?: number;
  db_daily_bandwidth_limit?: number;
  db_request_limit?: number;
  db_max_commands_per_second?: number;
  db_max_clients?: number;
};

/**
 * Upstash's own word for a database that has been idled away is "archived", and the state
 * strings seen in the wild are `active`, `passive` and `suspended`. Only `active` is treated
 * as healthy; anything that isn't recognised stays `unknown` rather than being guessed into
 * a status that would put a red banner on a working database.
 */
function lifecycleFromState(state: string | undefined): Lifecycle {
  switch ((state ?? "").toLowerCase()) {
    case "active":
      return "active";
    case "passive":
    case "suspended":
    case "archived":
      return "archived";
    case "deleted":
      return "deleted";
    default:
      return "unknown";
  }
}

/** An endpoint host, e.g. `eu1-fancy-cat-12345.upstash.io`. */
const ENDPOINT = /\b((?:[a-z0-9]+-)+[a-z0-9]+\.upstash\.io)\b/i;
const UUID = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

const accountFields: CredentialField[] = [
  {
    key: "api_email",
    label: "Upstash account email",
    help: "The email you sign into Upstash with. It is the username half of the Developer API's Basic auth, so it has to match exactly — including the +alias if you used one.",
    secret: false,
    required: false,
    tier: "server",
    placeholder: "you@example.com",
    validate: (v) => (v.includes("@") ? null : "That doesn't look like an email address."),
  },
  {
    key: "api_key",
    label: "Developer API key",
    help: "Upstash console → Account → Management API → Create API key. Read-only access isn't offered, so the key can create and delete databases — keep it to one account. Accounts created through the Vercel or Fly.io integrations don't have this section at all.",
    secret: true,
    required: false,
    tier: "server",
    placeholder: "••••••••-••••-••••-••••-••••••••••••",
    validate: (v) =>
      v.length >= 20 ? null : "An Upstash API key is a long random string; that looks too short.",
  },
  {
    key: "account_password",
    label: "Account login password",
    help: "Only if you sign into Upstash with email + password. Encrypted with your PIN — the server can't read it unattended.",
    secret: true,
    required: false,
    tier: "personal",
  },
];

const projectFields: CredentialField[] = [
  {
    key: "rest_token",
    label: "REST token",
    help: "SERVER TIER: the keep-alive ping is one HTTPS request to this database's REST API, so the sweep must be able to read this unattended. Keepstack fetches it for you if the Developer API returns it — otherwise copy it from the database page (UPSTASH_REDIS_REST_TOKEN).",
    secret: true,
    required: false,
    tier: "server",
    validate: (v) =>
      v.length >= 20 ? null : "A REST token is a long random string; that looks too short.",
  },
  {
    key: "db_password",
    label: "Redis password",
    help: "The password for redis:// clients, used to build REDIS_URL. Encrypted with your PIN, and never used by the sweep — the ping uses the REST token instead.",
    secret: true,
    required: false,
    tier: "personal",
  },
];

export const upstashAdapter: ProviderAdapter = {
  id: "upstash",
  name: "Upstash",
  accentVar: "--color-provider-upstash",

  capabilities: {
    discover: true,
    ping: true,
    // Both: Upstash has an inactivity clock *and* a monthly command budget, so it is the
    // first provider that needs pinging and watching at the same time.
    watch: true,
    revive: false,
    health: false,
    // `POST /v2/redis/reset-password/{id}` exists; Keepstack doesn't drive it yet.
    rotate: true,
  },

  policy: {
    strategy: "ping",
    /*
     * 14 days, deliberately the pessimistic reading.
     *
     * Upstash's FAQ exists in both a 14-day and a 30-day version with no dates on either, so
     * the real number is somewhere in that range and may have changed. Assuming 14 makes
     * Keepstack ping sooner than it might need to; assuming 30 would risk letting a database
     * be archived while the dashboard said it was fine. One of those errors is cheap.
     */
    pausesAfterDays: 14,
    // Archiving removes the instance but keeps a backup, so this isn't a deletion clock.
    deletesAfterDays: null,
    pauseNoun: "archived",
    defaultIntervalDays: 7,
    summary:
      "Upstash archives a free Redis database after a minimum of 14 days with no commands, emailing warnings first. Archiving takes a backup and removes the instance — your data survives, but you recover it by creating a new database and importing, which can only be done in the console. A ping is one HTTPS request against the REST API, so keeping one alive costs about 30 commands a year out of the 500,000/month allowance.",
    docsUrl: "https://upstash.com/docs/redis/help/faq",
  },

  accountFields,
  projectFields,

  parse(input: string): ParsedIdentifier | null {
    const s = input.trim();

    // A console URL carries the database id: console.upstash.com/redis/<uuid>
    const consoleUrl = s.match(/console\.upstash\.com\/redis\/([0-9a-f-]{36})/i);
    if (consoleUrl) return { externalId: consoleUrl[1].toLowerCase(), hint: "console URL" };

    /*
     * The endpoint host is checked before a bare UUID, because a `.env` holding both
     * UPSTASH_REDIS_REST_URL and some unrelated UUID should resolve to the database — and
     * because the host is what people actually have to hand. It is stored during discovery as
     * `metadata.endpoint`, which is how the registry matches it back.
     */
    const endpoint = s.match(ENDPOINT);
    if (endpoint) {
      return {
        externalId: endpoint[1].toLowerCase(),
        hint: s.includes("rediss://") || s.includes("redis://") ? "connection string" : "REST endpoint",
      };
    }

    const uuid = s.match(UUID);
    if (uuid) return { externalId: uuid[1].toLowerCase(), hint: "database ID" };

    return null;
  },

  consoleUrl: (project) => {
    // Only a database id reaches the detail page; an endpoint host doesn't, so that case
    // lands on the list instead of a URL that would 404.
    const id = project.metadata.database_id as string | undefined;
    const candidate = id ?? project.externalId;
    return UUID.test(candidate)
      ? `https://console.upstash.com/redis/${candidate}`
      : "https://console.upstash.com/redis";
  },

  async discover(credentials: Credentials): Promise<Discovered[]> {
    const res = await api(credentials, "/redis/databases");
    if (!res.ok) throw new Error(res.error);

    // The endpoint returns a bare array.
    const databases = (Array.isArray(res.data) ? res.data : []) as UpstashDatabase[];

    return databases.map((d) => ({
      externalId: d.database_id,
      name: d.database_name ?? d.database_id,
      region: d.region ?? null,
      plan: d.database_type ?? d.type ?? null,
      providerStatus: d.state ?? null,
      lifecycle: lifecycleFromState(d.state),
      createdAt: d.creation_time ? new Date(d.creation_time * 1000).toISOString() : null,
      metadata: {
        database_id: d.database_id,
        endpoint: d.endpoint ?? null,
        port: d.port ?? null,
        tls: d.tls ?? null,
        region: d.region ?? null,
        database_type: d.database_type ?? d.type ?? null,
        // Reported ceilings, kept so `usage()` can prefer them over the published figures.
        db_disk_threshold: d.db_disk_threshold ?? null,
        db_daily_bandwidth_limit: d.db_daily_bandwidth_limit ?? null,
        db_request_limit: d.db_request_limit ?? null,
        db_max_commands_per_second: d.db_max_commands_per_second ?? null,
      },
    }));
  },

  /**
   * Fetch the REST token so the user doesn't have to paste it.
   *
   * The published schema for this endpoint doesn't list `rest_token`, but its `credentials`
   * query parameter exists to *hide* credentials — which implies they're returned by default.
   * It could not be confirmed against a live account while this was written, so the code
   * treats the field as optional: present, it is stored; absent, the UI asks for it once.
   * Only the REST token is taken. The Redis password is `personal` tier by design, and
   * quietly storing it server-side would break that promise.
   */
  async fetchProjectCredentials(
    project: ProjectRef,
    credentials: Credentials,
  ): Promise<Record<string, string>> {
    const id = (project.metadata.database_id as string | undefined) ?? project.externalId;
    if (!UUID.test(id)) {
      throw new Error(
        "This database is registered by its endpoint host, so Keepstack can't look it up. Run a sync on the account to pick up its database ID first.",
      );
    }

    const res = await api(credentials, `/redis/database/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(res.error);

    const db = (res.data ?? {}) as UpstashDatabase;
    if (!db.rest_token) {
      throw new Error(
        "Upstash didn't return a REST token for this database. Copy UPSTASH_REDIS_REST_TOKEN from its console page and save it under Credentials instead.",
      );
    }
    return { rest_token: db.rest_token };
  },

  async status(project: ProjectRef, credentials: Credentials) {
    const id = (project.metadata.database_id as string | undefined) ?? project.externalId;
    if (!UUID.test(id)) {
      throw new Error("This database has no Upstash database ID stored. Run a sync on its account.");
    }

    const res = await api(credentials, `/redis/database/${encodeURIComponent(id)}`);
    if (!res.ok) {
      if (res.status === 404) return { lifecycle: "deleted" as Lifecycle, raw: "NOT_FOUND" };
      throw new Error(res.error);
    }

    const db = (res.data ?? {}) as UpstashDatabase;
    return { lifecycle: lifecycleFromState(db.state), raw: db.state ?? "UNKNOWN" };
  },

  /**
   * One `GET /ping` against the Redis REST API — the cheapest keep-alive in the set.
   *
   * It needs only the REST token, not the management key, so a database can be kept alive
   * without the Developer API at all (which matters: Vercel- and Fly-created accounts don't
   * have one). The endpoint host comes from discovery, or from the identifier itself when the
   * database was registered by pasting it.
   */
  async ping(project: ProjectRef, credentials: Credentials): Promise<PingOutcome> {
    const started = Date.now();
    const endpoint =
      (project.metadata.endpoint as string | undefined) ??
      (project.externalId.endsWith(".upstash.io") ? project.externalId : undefined);
    const token = credentials.rest_token;

    if (!endpoint || !token) {
      return {
        status: "error",
        strategy: "ping",
        httpStatus: null,
        durationMs: Date.now() - started,
        error: !endpoint
          ? "No REST endpoint known for this database. Run a sync on its account, or paste the endpoint host as the identifier."
          : "No REST token stored. Save one under Credentials, or press Fetch keys if this account has a Developer API key.",
      };
    }

    try {
      const res = await fetch(`https://${endpoint}/ping`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.text()).slice(0, 200);

      if (res.ok && /PONG/i.test(body)) {
        return {
          status: "ok",
          strategy: "ping",
          httpStatus: res.status,
          durationMs: Date.now() - started,
          error: null,
          lifecycle: "active",
          via: "Redis REST /ping",
        };
      }

      /*
       * A 401 here is ambiguous in a way that matters: a rotated token and an archived
       * database both stop the REST API answering. So the error says so, and the lifecycle is
       * left for `status()` below to settle rather than guessed from the HTTP code.
       */
      return {
        status: "error",
        strategy: "ping",
        httpStatus: res.status,
        durationMs: Date.now() - started,
        error:
          res.status === 401 || res.status === 403
            ? `The REST token was rejected (${res.status}). Either it has been rotated, or the database has been archived — check the status below. ${body}`
            : `Upstash REST ${res.status}: ${body || res.statusText}`,
        ...(await confirmedLifecycle(this, project, credentials)),
        via: "Redis REST /ping",
      };
    } catch (e) {
      return {
        status: "error",
        strategy: "ping",
        httpStatus: null,
        durationMs: Date.now() - started,
        error: (e as Error).message,
        ...(await confirmedLifecycle(this, project, credentials)),
        via: "Redis REST /ping",
      };
    }
  },

  /**
   * Monthly consumption, for the command budget that the ping spends from.
   *
   * Upstash reports this under `/v2/redis/stats/{id}`, whose response shape has changed over
   * time — so every figure is read defensively by name and anything absent is simply not
   * reported. A quota meter with no number beats a meter with an invented one.
   */
  async usage(project: ProjectRef, credentials: Credentials): Promise<UsageSnapshot[]> {
    const id = (project.metadata.database_id as string | undefined) ?? project.externalId;
    if (!UUID.test(id)) {
      throw new Error("This database has no Upstash database ID stored. Run a sync on its account.");
    }

    const res = await api(credentials, `/redis/stats/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(res.error);

    const stats = (res.data ?? {}) as Record<string, unknown>;
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const snapshots: UsageSnapshot[] = [];

    const commands = firstNumber(stats, ["total_monthly_requests", "total_monthly_commands"]);
    if (commands !== null) {
      snapshots.push({
        metric: "commands",
        value: commands,
        limitValue: (project.metadata.db_request_limit as number | null) ?? FREE_LIMITS.commands,
        unit: "commands",
        periodStart,
        periodEnd: now.toISOString(),
      });
    }

    const bandwidth = firstNumber(stats, ["total_monthly_bandwidth"]);
    if (bandwidth !== null) {
      snapshots.push({
        metric: "transfer_bytes",
        value: bandwidth,
        limitValue: FREE_LIMITS.bandwidthBytes,
        unit: "bytes",
        periodStart,
        periodEnd: now.toISOString(),
      });
    }

    // Storage is a point-in-time reading, so it carries no period — which is also what stops
    // `daysOfHeadroom` projecting a burn rate from it.
    const storage = firstNumber(stats, ["total_monthly_storage", "diskusage", "db_disk_size"]);
    if (storage !== null) {
      snapshots.push({
        metric: "storage_bytes",
        value: storage,
        limitValue:
          (project.metadata.db_disk_threshold as number | null) ?? FREE_LIMITS.storageBytes,
        unit: "bytes",
        periodStart: null,
        periodEnd: null,
      });
    }

    if (snapshots.length === 0) {
      throw new Error(
        "Upstash returned no usage figures Keepstack recognises. The stats endpoint's field names have changed before; the ping is unaffected.",
      );
    }

    return snapshots;
  },

  async overview(credentials: Credentials): Promise<AccountOverview> {
    const databases = await this.discover!(credentials);
    return {
      organizations: [
        {
          id: "account",
          name: "Upstash account",
          plan: databases.find((d) => d.plan)?.plan ?? null,
          projectCount: databases.length,
          // The free plan's database allowance has moved around, and the API doesn't report
          // it, so a number here would be a guess. The plan-limits card states the published
          // figure as a fact from the pricing page instead.
          freeProjectLimit: null,
        },
      ],
    };
  },

  /**
   * Redis has no pooled/direct split, so the pair is the two ways to reach the same database:
   * the REST URL that serverless code uses, and the TCP URL for a normal Redis client.
   */
  connectionStrings(project: ProjectRef, secrets: Record<string, string>): ConnectionStrings {
    const endpoint =
      (project.metadata.endpoint as string | undefined) ??
      (project.externalId.endsWith(".upstash.io") ? project.externalId : undefined);
    if (!endpoint) return { pooled: null, direct: null };

    const port = (project.metadata.port as number | undefined) ?? 6379;
    const password = secrets.db_password;

    return {
      pooled: `https://${endpoint}`,
      direct: password
        ? `rediss://default:${encodeURIComponent(password)}@${endpoint}:${port}`
        : null,
      labels: {
        pooled: { name: "UPSTASH_REDIS_REST_URL", hint: "REST, for serverless" },
        direct: { name: "REDIS_URL", hint: "TCP, for a Redis client" },
      },
    };
  },
};

/** The first of these keys holding a finite number, or null. */
function firstNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    // Some figures come back as numeric strings.
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

/**
 * Ask the management API what the lifecycle actually is, on a ping failure.
 *
 * Same reasoning as the Atlas adapter: a failed request could mean archived, rotated token,
 * or a network problem, and marking a database "archived" on a transient error would put a
 * red banner on a healthy one. Without a management key there is no verdict available, and
 * then nothing is claimed — the stored lifecycle is left alone.
 */
async function confirmedLifecycle(
  adapter: ProviderAdapter,
  project: ProjectRef,
  credentials: Credentials,
): Promise<{ lifecycle?: Lifecycle }> {
  if (!credentials.api_email || !credentials.api_key || !adapter.status) return {};
  try {
    const { lifecycle } = await adapter.status(project, credentials);
    return { lifecycle };
  } catch {
    return {};
  }
}
