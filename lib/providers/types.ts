/**
 * The provider adapter contract.
 *
 * Every provider-specific fact in Keepstack lives behind this interface. Nothing outside
 * `lib/providers/` may branch on which provider it is holding — the UI reads `capabilities`
 * and `policy` and renders from those. See docs/ARCHITECTURE.md §1.
 *
 * Adapters are deliberately pure-ish: they take credentials, talk to a provider, and return
 * normalised data. They never read the registry database, never touch `process.env`, and never
 * decrypt anything. Callers hand them plaintext. That is what makes them unit-testable against
 * recorded fixtures and safe for contributors to write.
 */

export const PROVIDER_IDS = ["supabase", "neon", "mongodb", "upstash", "appwrite"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * How a provider is kept alive. A property of the provider, never a user setting:
 * offering "ping every 5 days" for Neon would spend the user's compute budget to solve a
 * problem Neon does not have. See docs/PROVIDERS.md.
 */
export type Strategy =
  /** Idleness is the threat; a periodic real query resets the clock. */
  | "ping"
  /** Idleness is free and automatic; the threat is a quota that pinging would waste. */
  | "watch"
  /** Idleness is the threat, but no API action prevents it. Detect, count down, nag. */
  | "alert_only";

/** Normalised lifecycle, mapped from each provider's own vocabulary. */
export type Lifecycle = "active" | "idle" | "paused" | "archived" | "deleted" | "unknown";

/** What a provider can actually do. The UI renders from these flags. */
export type Capabilities = {
  /** List projects from an account-level credential. */
  discover: boolean;
  /** Perform an action that resets the inactivity clock. */
  ping: boolean;
  /** Report quota/usage metrics worth charting. */
  watch: boolean;
  /** Un-pause or un-archive from Keepstack's own UI. */
  revive: boolean;
  /** Report richer per-service status. */
  health: boolean;
  /** Rotate a database or role password. */
  rotate: boolean;
};

export type Policy = {
  strategy: Strategy;
  /** Days of inactivity before the provider acts. `null` = no inactivity policy. */
  pausesAfterDays: number | null;
  /** Days after pausing until data is destroyed. `null` = data kept indefinitely. */
  deletesAfterDays: number | null;
  /** What the provider calls it, so copy stays honest: "paused", "archived", "powered off". */
  pauseNoun: string;
  defaultIntervalDays: number;
  /** One sentence shown in the UI. Must match this provider's section in docs/PROVIDERS.md. */
  summary: string;
  docsUrl: string;
};

/**
 * A field we ask the user for.
 *
 * `tier` decides which key encrypts it (see docs/SECURITY.md §1):
 *  - `server`   — the nightly sweep needs it unattended, so the server must be able to read it.
 *  - `personal` — only the signed-in user, after a PIN or OTP unlock.
 */
export type CredentialTier = "server" | "personal";

export type CredentialField = {
  key: string;
  label: string;
  help: string;
  secret: boolean;
  required: boolean;
  tier: CredentialTier;
  placeholder?: string;
  /** Cheap sanity check. Returns an error message, or null when the value looks right. */
  validate?: (value: string) => string | null;
};

/** The minimum a caller must pass to identify a project at its provider. */
export type ProjectRef = {
  /** Supabase ref, Neon project id, Atlas cluster name, Upstash database id, Appwrite project id. */
  externalId: string;
  name: string;
  /** Provider-specific extras: org slug, group id, endpoint host, region, port. */
  metadata: Record<string, unknown>;
};

/** Plaintext credentials, keyed by `CredentialField.key`. Decryption happened before this point. */
export type Credentials = Record<string, string | undefined>;

export type PingOutcome = {
  status: "ok" | "error";
  /**
   * The strategy this attempt actually ran under. An `alert_only` provider records a status
   * check, never a successful keep-alive — the UI must not claim a ping prevented anything.
   */
  strategy: Strategy;
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
  /** Set when the attempt also told us something about the project's lifecycle. */
  lifecycle?: Lifecycle;
  /** Human-readable note about which transport was used, e.g. "management API SQL". */
  via?: string;
};

export type Discovered = {
  externalId: string;
  name: string;
  region: string | null;
  plan: string | null;
  /** The provider's own status string, kept verbatim for debugging. */
  providerStatus: string | null;
  lifecycle: Lifecycle;
  createdAt: string | null;
  metadata: Record<string, unknown>;
};

/** Per-service status, for providers that report more than up/down. */
export type HealthReport = {
  service: string;
  status: "healthy" | "unhealthy" | "unknown";
  detail?: string | null;
};

/** What `discover()` can tell us about an account's plan limits, for honest slot counters. */
export type AccountOverview = {
  /** Organisations/groups, with how many projects each holds and its plan where known. */
  organizations: {
    id: string;
    name: string;
    plan: string | null;
    projectCount: number;
    /** Free-tier project allowance, when the provider makes it knowable. */
    freeProjectLimit: number | null;
  }[];
};

export type UsageSnapshot = {
  metric: string;
  value: number;
  /** The plan's ceiling for this metric, when the provider reports one. */
  limitValue: number | null;
  unit: string;
  periodStart: string | null;
  periodEnd: string | null;
};

export type ConnectionStrings = {
  /** Pooled connection, for serverless runtimes. Prisma's `DATABASE_URL`. */
  pooled: string | null;
  /** Direct connection, for migrations. Prisma's `DIRECT_URL`. */
  direct: string | null;
};

/** Result of `parse()` — what we could pull out of a pasted blob. */
export type ParsedIdentifier = {
  externalId: string;
  /** Where it was found, shown in the UI: "project URL", "connection string", ".env file". */
  hint?: string;
};

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  /** CSS custom property holding this provider's accent, e.g. `--color-provider-supabase`. */
  accentVar: string;
  capabilities: Capabilities;
  policy: Policy;

  /** What an *account* needs for API access. */
  accountFields: CredentialField[];
  /** What a *project* needs. */
  projectFields: CredentialField[];

  /**
   * Paste-anything search. Pull an external id out of a URL, dashboard link, connection
   * string, or a whole `.env` file. Returns null when this provider doesn't recognise it.
   */
  parse(input: string): ParsedIdentifier | null;

  consoleUrl(project: ProjectRef): string;

  discover?(credentials: Credentials): Promise<Discovered[]>;

  /**
   * Fetch credentials the provider will hand us itself, so the user doesn't have to paste
   * them. Supabase returns anon keys from its Management API; Upstash returns REST tokens.
   * Keyed by `CredentialField.key`, and the caller stores them as `server`-tier secrets.
   */
  fetchProjectCredentials?(
    project: ProjectRef,
    credentials: Credentials,
  ): Promise<Record<string, string>>;

  /** Plan and organisation context, for free-slot counters that aren't guesses. */
  overview?(credentials: Credentials): Promise<AccountOverview>;

  health?(project: ProjectRef, credentials: Credentials): Promise<HealthReport[]>;

  ping?(project: ProjectRef, credentials: Credentials): Promise<PingOutcome>;
  status?(
    project: ProjectRef,
    credentials: Credentials,
  ): Promise<{ lifecycle: Lifecycle; raw: string }>;
  usage?(project: ProjectRef, credentials: Credentials): Promise<UsageSnapshot[]>;
  revive?(project: ProjectRef, credentials: Credentials): Promise<void>;
  connectionStrings?(project: ProjectRef, secrets: Record<string, string>): ConnectionStrings;
}
