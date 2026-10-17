import type {
  ConnectionStrings,
  CredentialField,
  Credentials,
  Discovered,
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
   * Hit the project's REST API with its anon key. With a ping table this runs a real
   * `select … limit 1` against Postgres, which is what counts as activity.
   *
   * Phase 3 adds the Management API path (`POST /v1/projects/{ref}/database/query`), which
   * needs no anon key and no keep_alive table. This is the fallback that keeps working for
   * users who haven't added a personal access token.
   */
  async ping(project: ProjectRef, credentials: Credentials): Promise<PingOutcome> {
    const anonKey = credentials.anon_key;
    const pingTable = (project.metadata.ping_table as string | undefined) ?? null;
    const base = `https://${project.externalId}.supabase.co`;
    const started = Date.now();

    if (!anonKey) {
      return {
        status: "error",
        strategy: "ping",
        httpStatus: null,
        durationMs: 0,
        error: "No anon/publishable key saved for this project",
      };
    }

    const headers: Record<string, string> = { apikey: anonKey };
    // Legacy anon keys are JWTs and go in Authorization too; new sb_publishable_ keys must not.
    if (anonKey.startsWith("eyJ")) headers.Authorization = `Bearer ${anonKey}`;

    const url = pingTable
      ? `${base}/rest/v1/${encodeURIComponent(pingTable)}?select=*&limit=1`
      : `${base}/auth/v1/health`;
    const via = pingTable ? `REST select on "${pingTable}"` : "auth health check";

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
        body = `Table "${pingTable}" not found — run the keep-alive SQL in this project. ${body}`;
      }
      if (res.status === 540 || /paused/i.test(body)) {
        body = `Project appears to be PAUSED — restore it from the dashboard. ${body}`;
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

  /**
   * Auto-discovery via the Management API. Wired into the UI in Phase 3; implemented here
   * because it is pure provider knowledge and belongs with the rest of it.
   */
  async discover(credentials: Credentials): Promise<Discovered[]> {
    const pat = credentials.pat;
    if (!pat) throw new Error("A Supabase personal access token is required to list projects.");

    const res = await fetch("https://api.supabase.com/v1/projects", {
      headers: { Authorization: `Bearer ${pat}` },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Supabase API ${res.status}: ${body || res.statusText}`);
    }

    const projects = (await res.json()) as {
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

  /** Un-pause a project. `POST /v1/projects/{ref}/restore`. */
  async revive(project: ProjectRef, credentials: Credentials): Promise<void> {
    const pat = credentials.pat;
    if (!pat) throw new Error("A Supabase personal access token is required to restore a project.");

    const res = await fetch(
      `https://api.supabase.com/v1/projects/${encodeURIComponent(project.externalId)}/restore`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Restore failed (${res.status}): ${body || res.statusText}`);
    }
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
