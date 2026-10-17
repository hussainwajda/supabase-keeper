import type {
  AccountOverview,
  ConnectionStrings,
  CredentialField,
  Credentials,
  Discovered,
  HealthReport,
  Lifecycle,
  ParsedIdentifier,
  PingOutcome,
  ProjectRef,
  ProviderAdapter,
} from "./types";

/** Supabase project refs are 20 lowercase alphanumerics. */
const REF = "[a-z0-9]{20}";

/**
 * Pull a project ref out of anything you might paste: a bare ref, an API URL
 * (https://<ref>.supabase.co), a dashboard URL (/dashboard/project/<ref>), a Postgres
 * connection string (postgres.<ref> / db.<ref>.supabase.co) or a whole .env file.
 */
export function extractRef(input: string): string | null {
  const s = input.trim().toLowerCase();
  const patterns: [RegExp, string][] = [
    [new RegExp(`^(${REF})$`), "project ref"],
    [new RegExp(`(${REF})\\.supabase\\.(?:co|in)`), "project URL"],
    [new RegExp(`/project/(${REF})`), "dashboard URL"],
    [new RegExp(`postgres\\.(${REF})`), "connection string"],
  ];
  for (const [p] of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return null;
}

export function dashboardUrl(ref: string) {
  return `https://supabase.com/dashboard/project/${ref}`;
}

/** Reject a service_role JWT pasted into an anon-key field. */
function looksLikeServiceRole(key: string): boolean {
  if (!key.startsWith("eyJ")) return false;
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString());
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

function validateAnonKey(key: string): string | null {
  if (key.startsWith("sb_secret_") || looksLikeServiceRole(key)) {
    return "That looks like a service_role / secret key. Only store the anon or publishable key here.";
  }
  return null;
}

/** Map Supabase's project status enum onto our normalised lifecycle. */
export function lifecycleFromStatus(status: string | null | undefined): Lifecycle {
  switch (status) {
    case "ACTIVE_HEALTHY":
    case "ACTIVE_UNHEALTHY":
      return "active";
    case "INACTIVE": // Supabase's word for "paused".
    case "PAUSING":
    case "PAUSE_FAILED":
      return "paused";
    case "REMOVED":
      return "deleted";
    case "COMING_UP":
    case "RESTORING":
    case "RESTARTING":
    case "UPGRADING":
    case "RESIZING":
    case "GOING_DOWN":
      return "idle";
    default:
      return "unknown";
  }
}

const accountFields: CredentialField[] = [
  {
    key: "pat",
    label: "Personal access token",
    help: "Create a scoped token at supabase.com/dashboard/account/tokens. Scope it to the organizations you want Keepstack to see — not a legacy full-access token. Unlocks auto-discovery, automatic anon keys, SQL keep-alive pings and one-click restore.",
    secret: true,
    required: false,
    tier: "server",
    placeholder: "sbp_...",
    validate: (v) =>
      v.startsWith("sbp_") ? null : "Supabase personal access tokens start with `sbp_`.",
  },
  {
    key: "account_password",
    label: "Account login password",
    help: "Only if you sign into Supabase with email + password and it isn't already in a password manager. Encrypted with your PIN — the server can't read it unattended.",
    secret: true,
    required: false,
    tier: "personal",
  },
];

const projectFields: CredentialField[] = [
  {
    key: "anon_key",
    label: "Anon / publishable key",
    help: "Project Settings → API. Never paste the service_role or secret key. Fetched automatically when the account has a personal access token.",
    secret: true,
    required: false,
    tier: "server",
    placeholder: "eyJhbGciOi… or sb_publishable_…",
    validate: validateAnonKey,
  },
  {
    key: "db_password",
    label: "Database password",
    help: "The Postgres password you chose when the project was created. Supabase never shows it again, and you need it for DATABASE_URL / DIRECT_URL. Encrypted with your PIN.",
    secret: true,
    required: false,
    tier: "personal",
  },
];

const API = "https://api.supabase.com/v1";

/**
 * One place for every Management API call: bearer auth, a timeout, and errors that quote the
 * provider instead of swallowing it. 429 is called out because the limit (120/min per user,
 * per endpoint) is easy to hit while syncing several accounts at once.
 */
async function api(
  pat: string,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${pat}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const error =
        res.status === 401
          ? "The personal access token was rejected. It may be revoked, expired, or scoped to a different organization."
          : res.status === 429
            ? "Supabase rate limit reached (120 requests/minute). Try again shortly."
            : `Supabase API ${res.status}: ${body || res.statusText}`;
      return { ok: false, status: res.status, error };
    }

    const text = await res.text();
    return { ok: true, data: text ? JSON.parse(text) : null };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

export const supabaseAdapter: ProviderAdapter = {
  id: "supabase",
  name: "Supabase",
  accentVar: "--color-provider-supabase",

  capabilities: {
    discover: true,
    ping: true,
    watch: false,
    revive: true,
    health: true,
    rotate: true,
  },

  policy: {
    strategy: "ping",
    pausesAfterDays: 7,
    deletesAfterDays: null,
    pauseNoun: "paused",
    defaultIntervalDays: 5,
    summary:
      "Free projects pause after 7 days without activity. Data is kept and can be restored. Two free projects per organization.",
    docsUrl: "https://supabase.com/docs/guides/platform/billing-on-supabase#inactive-projects",
  },

  accountFields,
  projectFields,

  parse(input: string): ParsedIdentifier | null {
    const s = input.trim().toLowerCase();
    const patterns: [RegExp, string][] = [
      [new RegExp(`^(${REF})$`), "project ref"],
      [new RegExp(`(${REF})\\.supabase\\.(?:co|in)`), "project URL"],
      [new RegExp(`/project/(${REF})`), "dashboard URL"],
      [new RegExp(`postgres\\.(${REF})`), "connection string"],
    ];
    for (const [p, hint] of patterns) {
      const m = s.match(p);
      if (m) return { externalId: m[1], hint };
    }
    return null;
  },

  consoleUrl: (project) => dashboardUrl(project.externalId),

  /**
   * Keep the project alive, best transport first.
   *
   *   1. **Management API SQL** (`POST /v1/projects/{ref}/database/query`) — a real
   *      `select 1` against Postgres. No anon key, no `keep_alive` table, and it works even
   *      when PostgREST is unhealthy. Marked experimental/beta in Supabase's own spec, which
   *      is exactly why it's a preferred path with fallbacks rather than the only path.
   *   2. **REST on a table** with the anon key — the original behaviour.
   *   3. **Auth health check** — weakest; proves the gateway is up, not that Postgres ran
   *      anything, so it is a last resort and is labelled as such in the log.
   */
  async ping(project: ProjectRef, credentials: Credentials): Promise<PingOutcome> {
    const started = Date.now();
    const ref = project.externalId;

    if (credentials.pat) {
      const res = await api(credentials.pat, `/projects/${encodeURIComponent(ref)}/database/query`, {
        method: "POST",
        body: JSON.stringify({ query: "select 1 as keepstack_ping;", read_only: true }),
      });
      const durationMs = Date.now() - started;

      if (res.ok) {
        return {
          status: "ok",
          strategy: "ping",
          httpStatus: 201,
          durationMs,
          error: null,
          lifecycle: "active",
          via: "management API SQL (select 1)",
        };
      }

      // A paused project can't run SQL. Report that clearly rather than as a generic failure.
      if (/paused|not found|inactive/i.test(res.error) || res.status === 404) {
        return {
          status: "error",
          strategy: "ping",
          httpStatus: res.status || null,
          durationMs,
          error: `Project appears to be PAUSED or unreachable — use Restore. ${res.error}`,
          lifecycle: "paused",
          via: "management API SQL",
        };
      }

      // Anything else (a 401 on a narrowly scoped token, a 5xx, the beta endpoint changing):
      // fall through to the anon-key path rather than reporting a false failure.
      if (!credentials.anon_key) {
        return {
          status: "error",
          strategy: "ping",
          httpStatus: res.status || null,
          durationMs,
          error: res.error,
          via: "management API SQL",
        };
      }
    }

    const anonKey = credentials.anon_key;
    if (!anonKey) {
      return {
        status: "error",
        strategy: "ping",
        httpStatus: null,
        durationMs: Date.now() - started,
        error:
          "No credentials for this project. Add a personal access token to its account, or save an anon/publishable key.",
      };
    }

    const base = `https://${ref}.supabase.co`;
    const pingTable = (project.metadata.ping_table as string | undefined) ?? null;

    const headers: Record<string, string> = { apikey: anonKey };
    // Legacy anon keys are JWTs and go in Authorization too; new sb_publishable_ keys must not.
    if (anonKey.startsWith("eyJ")) headers.Authorization = `Bearer ${anonKey}`;

    const url = pingTable
      ? `${base}/rest/v1/${encodeURIComponent(pingTable)}?select=*&limit=1`
      : `${base}/auth/v1/health`;
    const via = pingTable ? `REST select on "${pingTable}"` : "auth health check (weak)";

    try {
      const res = await fetch(url, {
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const durationMs = Date.now() - started;
      if (res.ok) {
        return {
          status: "ok",
          strategy: "ping",
          httpStatus: res.status,
          durationMs,
          error: null,
          lifecycle: "active",
          via,
        };
      }

      let body = (await res.text()).slice(0, 300);
      let lifecycle: Lifecycle = "unknown";
      if (res.status === 404 && pingTable) {
        body = `Table "${pingTable}" not found — run the keep-alive SQL in this project, or add a personal access token to its account to ping without one. ${body}`;
      }
      if (res.status === 540 || /paused/i.test(body)) {
        body = `Project appears to be PAUSED — restore it. ${body}`;
        lifecycle = "paused";
      }
      return {
        status: "error",
        strategy: "ping",
        httpStatus: res.status,
        durationMs,
        error: body || res.statusText,
        lifecycle,
        via,
      };
    } catch (e) {
      return {
        status: "error",
        strategy: "ping",
        httpStatus: null,
        durationMs: Date.now() - started,
        error: (e as Error).message,
        via,
      };
    }
  },

  /** Auto-discovery: every project the token can see, with its real status. */
  async discover(credentials: Credentials): Promise<Discovered[]> {
    const pat = credentials.pat;
    if (!pat) throw new Error("A Supabase personal access token is required to list projects.");

    const res = await api(pat, "/projects");
    if (!res.ok) throw new Error(res.error);

    const projects = (res.data ?? []) as {
      ref: string;
      name: string;
      region: string;
      status: string;
      created_at: string;
      organization_slug: string;
      database?: { host?: string; version?: string };
    }[];

    return projects.map((p) => ({
      externalId: p.ref,
      name: p.name,
      region: p.region ?? null,
      plan: null,
      providerStatus: p.status ?? null,
      lifecycle: lifecycleFromStatus(p.status),
      createdAt: p.created_at ?? null,
      metadata: {
        organization_slug: p.organization_slug,
        db_host: p.database?.host ?? null,
        db_version: p.database?.version ?? null,
      },
    }));
  },

  /** One project's current status, without listing everything. */
  async status(project: ProjectRef, credentials: Credentials) {
    const pat = credentials.pat;
    if (!pat) throw new Error("A Supabase personal access token is required to read status.");

    const res = await api(pat, `/projects/${encodeURIComponent(project.externalId)}`);
    if (!res.ok) {
      // A ref the token can't see reads as removed rather than as an error, because that is
      // what it means operationally: it is gone, or it belongs to another organization.
      if (res.status === 404) return { lifecycle: "deleted" as Lifecycle, raw: "NOT_FOUND" };
      throw new Error(res.error);
    }

    const raw = ((res.data as { status?: string })?.status ?? "UNKNOWN") as string;
    return { lifecycle: lifecycleFromStatus(raw), raw };
  },

  /** Per-service health, so "the project is up" can be more specific than a single ping. */
  async health(project: ProjectRef, credentials: Credentials): Promise<HealthReport[]> {
    const pat = credentials.pat;
    if (!pat) return [];

    const services = "db,auth,rest,realtime,storage";
    const res = await api(
      pat,
      `/projects/${encodeURIComponent(project.externalId)}/health?services=${services}`,
    );
    if (!res.ok) return [];

    return ((res.data ?? []) as { name?: string; healthy?: boolean; status?: string; error?: string }[]).map(
      (h) => ({
        service: h.name ?? "unknown",
        status: h.healthy === true ? "healthy" : h.healthy === false ? "unhealthy" : "unknown",
        detail: h.error ?? h.status ?? null,
      }),
    );
  },

  /**
   * Fetch the project's anon/publishable key so the user never has to paste one.
   *
   * Prefers a publishable key, then a legacy anon JWT. Secret and service_role keys are
   * filtered out explicitly — this runs unattended and stores what it finds as a `server`
   * secret, so picking the wrong one would quietly put a God-mode key in the registry.
   */
  async fetchProjectCredentials(
    project: ProjectRef,
    credentials: Credentials,
  ): Promise<Record<string, string>> {
    const pat = credentials.pat;
    if (!pat) return {};

    const res = await api(pat, `/projects/${encodeURIComponent(project.externalId)}/api-keys`);
    if (!res.ok) return {};

    const keys = (res.data ?? []) as { name?: string; api_key?: string; type?: string }[];
    const safe = keys.filter((k) => {
      const value = k.api_key ?? "";
      if (!value) return false;
      if (value.startsWith("sb_secret_")) return false;
      if (k.name === "service_role") return false;
      return !looksLikeServiceRole(value);
    });

    const publishable = safe.find((k) => k.api_key!.startsWith("sb_publishable_"));
    const anon = safe.find((k) => k.name === "anon") ?? safe.find((k) => k.api_key!.startsWith("eyJ"));
    const chosen = publishable ?? anon;

    return chosen?.api_key ? { anon_key: chosen.api_key } : {};
  },

  /**
   * Organisations and their project counts, so the free-slot counter reflects reality rather
   * than assuming two per account.
   */
  async overview(credentials: Credentials): Promise<AccountOverview> {
    const pat = credentials.pat;
    if (!pat) throw new Error("A Supabase personal access token is required.");

    const orgsRes = await api(pat, "/organizations");
    if (!orgsRes.ok) throw new Error(orgsRes.error);

    const orgs = (orgsRes.data ?? []) as { id: string; slug?: string; name: string; plan?: string }[];
    const projects = await this.discover!(credentials);

    return {
      organizations: orgs.map((o) => {
        const slug = o.slug ?? o.id;
        const plan = o.plan ?? null;
        return {
          id: slug,
          name: o.name,
          plan,
          projectCount: projects.filter((p) => p.metadata.organization_slug === slug).length,
          // Free organisations get two active projects; paid plans have no small fixed cap
          // worth showing, so report null rather than inventing a number.
          freeProjectLimit: plan === null || plan === "free" ? 2 : null,
        };
      }),
    };
  },

  /** Un-pause a project. `POST /v1/projects/{ref}/restore`. */
  async revive(project: ProjectRef, credentials: Credentials): Promise<void> {
    const pat = credentials.pat;
    if (!pat) throw new Error("A Supabase personal access token is required to restore a project.");

    const res = await api(pat, `/projects/${encodeURIComponent(project.externalId)}/restore`, {
      method: "POST",
      body: "{}",
    });
    if (!res.ok) throw new Error(`Restore failed. ${res.error}`);
  },

  /**
   * Assemble Prisma-style URLs from a stored database password.
   *
   * The pooler host is read from `metadata.pooler_host` when discovery supplied it. We do not
   * guess `aws-0-<region>.pooler.supabase.com` — that pattern has changed before. Without a
   * known pooler host we return the direct URL only, which is correct rather than plausible.
   */
  connectionStrings(project: ProjectRef, secrets: Record<string, string>): ConnectionStrings {
    const password = secrets.db_password;
    if (!password) return { pooled: null, direct: null };

    const ref = project.externalId;
    const encoded = encodeURIComponent(password);
    const poolerHost = project.metadata.pooler_host as string | undefined;
    const directHost = (project.metadata.db_host as string | undefined) ?? `db.${ref}.supabase.co`;

    return {
      pooled: poolerHost
        ? `postgresql://postgres.${ref}:${encoded}@${poolerHost}:6543/postgres?pgbouncer=true&connection_limit=1`
        : null,
      direct: `postgresql://postgres:${encoded}@${directHost}:5432/postgres`,
    };
  },
};
