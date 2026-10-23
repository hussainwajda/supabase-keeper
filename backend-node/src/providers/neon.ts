import type {
  AccountOverview,
  ConnectionStrings,
  CredentialField,
  Credentials,
  Discovered,
  Lifecycle,
  ParsedIdentifier,
  ProjectRef,
  ProviderAdapter,
  UsageSnapshot,
} from "./types";

const API = "https://console.neon.tech/api/v2";

/**
 * Neon's Free plan quotas, per project per month. Read from the API where possible — these
 * are the fallbacks for when it doesn't say, and sources disagree on storage (0.5 vs 1 GB),
 * so the smaller figure is used to avoid a reassuring-but-wrong headroom number.
 */
const FREE_LIMITS = {
  computeCuHours: 100,
  storageBytes: 0.5 * 1024 ** 3,
  transferBytes: 5 * 1024 ** 3,
} as const;

async function api(
  key: string,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const error =
        res.status === 401 || res.status === 403
          ? "The Neon API key was rejected. It may be revoked, or scoped to a different organization."
          : res.status === 429
            ? "Neon rate limit reached. Try again shortly."
            : `Neon API ${res.status}: ${body || res.statusText}`;
      return { ok: false, status: res.status, error };
    }

    const text = await res.text();
    return { ok: true, data: text ? JSON.parse(text) : null };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

/**
 * Neon project IDs are three words and a number, like `fragrant-dew-12345678`, and appear in
 * endpoint hostnames as `ep-<something>-<id>`. The project id is what the API wants.
 */
const PROJECT_ID = "[a-z]+-[a-z]+-[0-9]{6,10}";

function lifecycleFromEndpoints(states: string[]): Lifecycle {
  if (states.length === 0) return "unknown";
  if (states.some((s) => s === "active")) return "active";
  // "idle" is Neon's normal resting state, not a problem — scale-to-zero is the design.
  if (states.every((s) => s === "idle")) return "idle";
  return "unknown";
}

const accountFields: CredentialField[] = [
  {
    key: "api_key",
    label: "Neon API key",
    help: "Neon console → Account settings → API keys. An organization-scoped key sees that org's projects; a personal key sees your own. Used to read projects and consumption — Keepstack never writes to your databases.",
    secret: true,
    required: false,
    tier: "server",
    placeholder: "napi_...",
    validate: (v) =>
      v.startsWith("napi_") || v.length > 20
        ? null
        : "That doesn't look like a Neon API key (they usually start with `napi_`).",
  },
  {
    key: "account_password",
    label: "Account login password",
    help: "Only if you sign into Neon with email + password. Encrypted with your PIN — the server can't read it unattended.",
    secret: true,
    required: false,
    tier: "personal",
  },
];

const projectFields: CredentialField[] = [
  {
    key: "db_password",
    label: "Role password",
    help: "The password for your Postgres role, used in DATABASE_URL. Neon shows it once at creation; you can reset it from the console. Encrypted with your PIN.",
    secret: true,
    required: false,
    tier: "personal",
  },
  {
    key: "connection_string",
    label: "Connection string",
    help: "The full pooled connection string, if you'd rather store it whole than rebuild it. Encrypted with your PIN.",
    secret: true,
    required: false,
    tier: "personal",
  },
];

export const neonAdapter: ProviderAdapter = {
  id: "neon",
  name: "Neon",
  accentVar: "--color-provider-neon",

  capabilities: {
    discover: true,
    // No ping, on purpose. See `policy.summary` — pinging Neon spends the quota that is the
    // actual risk. The UI reads this flag and never offers an interval.
    ping: false,
    watch: true,
    revive: false,
    health: false,
    rotate: true,
  },

  policy: {
    strategy: "watch",
    pausesAfterDays: null,
    deletesAfterDays: null,
    pauseNoun: "suspended",
    defaultIntervalDays: 1,
    summary:
      "Neon never pauses a project for being idle — compute scales to zero after 5 minutes and wakes on the next connection, free of charge. The real limit is 100 compute-hours per project per month; exhausting it suspends the compute until the next billing period. Keepstack watches that budget instead of pinging, because a ping would spend the very thing it's protecting.",
    docsUrl: "https://neon.com/docs/introduction/usage-metrics",
  },

  accountFields,
  projectFields,

  parse(input: string): ParsedIdentifier | null {
    const s = input.trim().toLowerCase();
    const patterns: [RegExp, string][] = [
      [new RegExp(`^(${PROJECT_ID})$`), "project ID"],
      // console.neon.tech/app/projects/<id>
      [new RegExp(`/projects/(${PROJECT_ID})`), "console URL"],
      // A connection host: ep-cool-darkness-12345678.eu-central-1.aws.neon.tech
      [new RegExp(`ep-(${PROJECT_ID})\\.`), "connection string"],
      [new RegExp(`@ep-[a-z0-9-]*?(${PROJECT_ID})`), "connection string"],
    ];
    for (const [p, hint] of patterns) {
      const m = s.match(p);
      if (m) return { externalId: m[1], hint };
    }
    return null;
  },

  consoleUrl: (project) =>
    `https://console.neon.tech/app/projects/${encodeURIComponent(project.externalId)}`,

  async discover(credentials: Credentials): Promise<Discovered[]> {
    const key = credentials.api_key;
    if (!key) throw new Error("A Neon API key is required to list projects.");

    const res = await api(key, "/projects");
    if (!res.ok) throw new Error(res.error);

    const projects = ((res.data as { projects?: unknown[] })?.projects ?? []) as {
      id: string;
      name: string;
      region_id?: string;
      created_at?: string;
      org_id?: string;
      platform_id?: string;
      pg_version?: number;
      synthetic_storage_size?: number;
      owner?: { subscription_type?: string };
    }[];

    return projects.map((p) => ({
      externalId: p.id,
      name: p.name,
      region: p.region_id ?? null,
      plan: p.owner?.subscription_type ?? null,
      providerStatus: null,
      // Neon has no paused state to report at the project level; endpoints idle and wake on
      // their own, so "active" is the honest default here.
      lifecycle: "active" as Lifecycle,
      createdAt: p.created_at ?? null,
      metadata: {
        org_id: p.org_id ?? null,
        pg_version: p.pg_version ?? null,
        storage_bytes: p.synthetic_storage_size ?? null,
      },
    }));
  },

  /** Endpoint states, which is as close as Neon gets to a status. */
  async status(project: ProjectRef, credentials: Credentials) {
    const key = credentials.api_key;
    if (!key) throw new Error("A Neon API key is required.");

    const res = await api(key, `/projects/${encodeURIComponent(project.externalId)}/endpoints`);
    if (!res.ok) {
      if (res.status === 404) return { lifecycle: "deleted" as Lifecycle, raw: "NOT_FOUND" };
      throw new Error(res.error);
    }

    const endpoints = ((res.data as { endpoints?: unknown[] })?.endpoints ?? []) as {
      current_state?: string;
    }[];
    const states = endpoints.map((e) => e.current_state ?? "unknown");
    return { lifecycle: lifecycleFromEndpoints(states), raw: states.join(",") || "no endpoints" };
  },

  /**
   * Consumption for the current billing period.
   *
   * `/consumption_history/v2/projects` needs an `org_id`, which not every key has, so this
   * falls back to the per-project `GET /projects/{id}` figures. That is less precise but
   * always available, and a headroom warning from approximate data beats no warning.
   */
  async usage(project: ProjectRef, credentials: Credentials): Promise<UsageSnapshot[]> {
    const key = credentials.api_key;
    if (!key) throw new Error("A Neon API key is required.");

    const snapshots: UsageSnapshot[] = [];
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const orgId = project.metadata.org_id as string | undefined;
    if (orgId) {
      const params = new URLSearchParams({
        org_id: orgId,
        from: periodStart.toISOString(),
        to: now.toISOString(),
        granularity: "monthly",
        project_ids: project.externalId,
      });
      // Repeated params, which is how the API takes a metric list.
      for (const m of [
        "compute_unit_seconds",
        "root_branch_bytes_month",
        "public_network_transfer_bytes",
      ]) {
        params.append("metrics", m);
      }

      const res = await api(key, `/consumption_history/v2/projects?${params}`);
      if (res.ok) {
        const data = res.data as {
          projects?: { periods?: { consumption?: { metrics?: { metric_name: string; value: number }[] }[] }[] }[];
        };

        const totals: Record<string, number> = {};
        for (const p of data.projects ?? []) {
          for (const period of p.periods ?? []) {
            for (const c of period.consumption ?? []) {
              for (const m of c.metrics ?? []) {
                totals[m.metric_name] = (totals[m.metric_name] ?? 0) + m.value;
              }
            }
          }
        }

        if (totals.compute_unit_seconds !== undefined) {
          snapshots.push({
            metric: "compute_cu_hours",
            // The API reports CU-seconds; the plan is quoted in CU-hours.
            value: totals.compute_unit_seconds / 3600,
            limitValue: FREE_LIMITS.computeCuHours,
            unit: "CU-hours",
            periodStart: periodStart.toISOString(),
            periodEnd: now.toISOString(),
          });
        }
        if (totals.public_network_transfer_bytes !== undefined) {
          snapshots.push({
            metric: "transfer_bytes",
            value: totals.public_network_transfer_bytes,
            limitValue: FREE_LIMITS.transferBytes,
            unit: "bytes",
            periodStart: periodStart.toISOString(),
            periodEnd: now.toISOString(),
          });
        }
      }
    }

    // Storage is a point-in-time figure, so read it from the project either way.
    const projectRes = await api(key, `/projects/${encodeURIComponent(project.externalId)}`);
    if (projectRes.ok) {
      const p = (projectRes.data as { project?: { synthetic_storage_size?: number } })?.project;
      if (p?.synthetic_storage_size !== undefined) {
        snapshots.push({
          metric: "storage_bytes",
          value: p.synthetic_storage_size,
          limitValue: FREE_LIMITS.storageBytes,
          unit: "bytes",
          periodStart: null,
          periodEnd: null,
        });
      }
    }

    if (snapshots.length === 0) {
      throw new Error(
        "Neon returned no consumption data. An organization-scoped API key is needed for compute and transfer figures.",
      );
    }

    return snapshots;
  },

  async overview(credentials: Credentials): Promise<AccountOverview> {
    const key = credentials.api_key;
    if (!key) throw new Error("A Neon API key is required.");

    const projects = await this.discover!(credentials);
    const res = await api(key, "/users/me/organizations");

    const orgs = res.ok
      ? (((res.data as { organizations?: unknown[] })?.organizations ?? []) as {
          id: string;
          name: string;
          plan?: string;
        }[])
      : [];

    if (orgs.length === 0) {
      return {
        organizations: [
          {
            id: "personal",
            name: "Personal account",
            plan: projects[0]?.plan ?? null,
            projectCount: projects.length,
            // The Free plan allows a lot of projects; the binding limit is compute, not count.
            freeProjectLimit: null,
          },
        ],
      };
    }

    return {
      organizations: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        plan: o.plan ?? null,
        projectCount: projects.filter((p) => p.metadata.org_id === o.id).length,
        freeProjectLimit: null,
      })),
    };
  },

  /**
   * Suspend a compute on demand — the opposite of a ping, and the only control that makes
   * sense for a `watch` provider: it stops the quota burning.
   */
  async revive(): Promise<void> {
    throw new Error(
      "Neon projects are never paused for inactivity, so there is nothing to restore. If the compute is suspended for exhausting its quota, it resumes at the next billing period or on upgrading.",
    );
  },

  connectionStrings(project: ProjectRef, secrets: Record<string, string>): ConnectionStrings {
    // Prefer a stored whole string: Neon's host includes a generated endpoint id we can't
    // reconstruct from the project id alone, so guessing it would be wrong.
    const stored = secrets.connection_string;
    if (stored) {
      return {
        pooled: stored.includes("-pooler.") ? stored : stored.replace(/@ep-([^.]+)\./, "@ep-$1-pooler."),
        direct: stored.replace("-pooler.", "."),
      };
    }

    const host = project.metadata.endpoint_host as string | undefined;
    const password = secrets.db_password;
    const role = (project.metadata.role_name as string | undefined) ?? "neondb_owner";
    const database = (project.metadata.database_name as string | undefined) ?? "neondb";
    if (!host || !password) return { pooled: null, direct: null };

    const encoded = encodeURIComponent(password);
    const pooledHost = host.includes("-pooler.") ? host : host.replace(/^(ep-[^.]+)\./, "$1-pooler.");
    return {
      pooled: `postgresql://${role}:${encoded}@${pooledHost}/${database}?sslmode=require`,
      direct: `postgresql://${role}:${encoded}@${host.replace("-pooler.", ".")}/${database}?sslmode=require`,
    };
  },
};
