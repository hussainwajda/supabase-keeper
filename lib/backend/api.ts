import "server-only";
import { cache } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "./client";
import type { Account, PingLog, Project, ProjectWithAccount } from "@/lib/registry/types";
import type { AuditRow } from "@/lib/vault/audit";
import type { SecretSummary } from "@/lib/vault/secrets";
import type { UsageRow } from "@/lib/usage";
import type {
  ConnectionStrings,
  Discovered,
  HealthReport,
  Lifecycle,
  ProviderId,
} from "@/lib/providers/types";

/**
 * The Node backend's REST surface, typed.
 *
 * Every method returns one of the app's existing row types. That is not a happy accident —
 * `backend-node/src/http/serialize.ts` was written to emit exactly the shapes in
 * `lib/registry/types.ts`, field for field, so these types *are* the API contract and the
 * same components render either backend's data without knowing which one answered.
 */

// ─── auth ─────────────────────────────────────────────────────────────────────

export type ApiUser = {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  has_password: boolean;
  google_linked: boolean;
  created_at: string;
};

export const authConfig = cache(() =>
  apiGet<{ google: boolean; signup: boolean; password: boolean }>("/auth/config"),
);

/**
 * Deduped for the length of one render.
 *
 * `apiGet` sends `cache: "no-store"`, which switches off Next's own fetch memoisation — right
 * for freshness, but it meant the layout and the page it wraps each paid a round trip for the
 * same answer. The dashboard was fetching the vault status three times and the session twice
 * before painting anything. `cache()` collapses those to one call per request without making
 * any of it stale: a new request, including the re-render after a server action, starts with
 * an empty cache.
 *
 * Only safe on reads. Nothing that writes goes through here.
 */
export const me = cache(() => apiGet<{ user: ApiUser }>("/auth/me"));

export const login = (email: string, password: string) =>
  apiPost<{ user: ApiUser }>("/auth/login", { email, password });

export const signup = (email: string, password: string, displayName?: string | null) =>
  apiPost<{ user: ApiUser; first_user: boolean }>("/auth/signup", {
    email,
    password,
    display_name: displayName ?? null,
  });

export const logout = () => apiPost<{ ok: boolean }>("/auth/logout");

export const changePassword = (currentPassword: string, newPassword: string) =>
  apiPost<{ ok: boolean; notice: string }>("/auth/password", {
    current_password: currentPassword,
    new_password: newPassword,
  });

// ─── accounts ─────────────────────────────────────────────────────────────────

export const listAccounts = cache(() =>
  apiGet<{ accounts: Account[]; slots_used: Record<string, number> }>("/api/accounts"),
);

export const createAccount = (body: Record<string, unknown>) =>
  apiPost<{ account: Account }>("/api/accounts", body);

export const updateAccount = (id: string, body: Record<string, unknown>) =>
  apiPatch<{ account: Account }>(`/api/accounts/${id}`, body);

export const deleteAccount = (id: string) => apiDelete<{ ok: boolean }>(`/api/accounts/${id}`);

// ─── projects ─────────────────────────────────────────────────────────────────

/** The list carries `has_key`, so the dashboard's "no anon key" warning needs no second call. */
export const listProjects = cache(() =>
  apiGet<{ projects: (ProjectWithAccount & { has_key: boolean })[] }>("/api/projects"),
);

export const getProject = (id: string) =>
  apiGet<{ project: ProjectWithAccount }>(`/api/projects/${id}`);

export const createProject = (body: Record<string, unknown>) =>
  apiPost<{ project: Project }>("/api/projects", body);

export const updateProject = (id: string, body: Record<string, unknown>) =>
  apiPatch<{ project: Project }>(`/api/projects/${id}`, body);

export const deleteProject = (id: string) => apiDelete<{ ok: boolean }>(`/api/projects/${id}`);

export const recentLogs = (id: string, limit = 15) =>
  apiGet<{ logs: PingLog[] }>(`/api/projects/${id}/logs`, { limit });

export const latestUsage = (id: string) => apiGet<{ usage: UsageRow[] }>(`/api/projects/${id}/usage`);

export const usageHistory = (id: string, metric: string, days = 30) =>
  apiGet<{ history: UsageRow[] }>(`/api/projects/${id}/usage/${encodeURIComponent(metric)}`, {
    days,
  });

export const exportRegistry = () => apiGet<Record<string, unknown>>("/api/export");

// ─── provider actions ─────────────────────────────────────────────────────────

export const parseIdentifier = (input: string) =>
  apiPost<{ parsed: { provider: ProviderId; externalId: string; hint?: string } | null }>(
    "/api/parse",
    { input },
  );

export type ApiSyncPlan = {
  provider: ProviderId;
  accountId: string;
  toCreate: Discovered[];
  toUpdate: {
    id: string;
    name: string;
    changes: Record<string, { from: unknown; to: unknown }>;
    discovered: Discovered;
  }[];
  unchanged: number;
  missing: { id: string; name: string; externalId: string }[];
  reassigned: { id: string; name: string; externalId: string; fromAccountId: string | null }[];
};

export const previewSync = (accountId: string, provider: ProviderId) =>
  apiPost<{ plan: ApiSyncPlan }>(`/api/accounts/${accountId}/sync/preview`, { provider });

export const applySync = (
  accountId: string,
  provider: ProviderId,
  options: { adopt?: boolean; fetchKeys?: boolean } = {},
) =>
  apiPost<{
    result: { created: number; updated: number; reassigned: number; keysFetched: number };
    notice: string;
  }>(`/api/accounts/${accountId}/sync/apply`, {
    provider,
    adopt: options.adopt === true,
    fetch_keys: options.fetchKeys === true,
  });

export const pingProject = (id: string) =>
  apiPost<{ result: Record<string, unknown> }>(`/api/projects/${id}/ping`);

export const pingAll = () =>
  apiPost<{ processed: number; results: Record<string, unknown>[] }>("/api/ping-all");

export const refreshStatus = (id: string) =>
  apiPost<{ lifecycle: Lifecycle; provider_status: string | null; stale?: boolean }>(
    `/api/projects/${id}/status`,
  );

export const refreshUsage = (id: string) =>
  apiPost<{ result: Record<string, unknown> }>(`/api/projects/${id}/usage`);

export const restoreProject = (id: string) =>
  apiPost<{ ok: boolean; notice: string }>(`/api/projects/${id}/restore`);

export const fetchHealth = (id: string) =>
  apiGet<{ health: HealthReport[] }>(`/api/projects/${id}/health`);

export const fetchProjectKeys = (id: string) =>
  apiPost<{ stored: string[]; notice: string }>(`/api/projects/${id}/keys`);

export const connectionStrings = (id: string) =>
  apiPost<ConnectionStrings>(`/api/projects/${id}/connection-strings`);

// ─── vault ────────────────────────────────────────────────────────────────────

export type ApiVaultStatus = {
  initialized: boolean;
  recoveryEnabled: boolean;
  lockedUntil: string | null;
  failedAttempts: number;
  unlocked: boolean;
  remaining_seconds: number;
  otp_available: boolean;
  otp_transport: "resend" | "dev-echo" | "none";
  configured: boolean;
  problems: string[];
};

export const vaultStatus = cache(() => apiGet<ApiVaultStatus>("/api/vault/status"));

export const setupPin = (pin: string, confirm: string) =>
  apiPost<{ notice: string }>("/api/vault/pin", { pin, confirm });

export const changePin = (pin: string, confirm: string) =>
  apiPatch<{ notice: string }>("/api/vault/pin", { pin, confirm });

export const resetPin = (code: string, pin: string, confirm: string) =>
  apiPost<{ notice: string }>("/api/vault/pin/reset", { code, pin, confirm });

export const unlockWithPin = (pin: string) =>
  apiPost<{ notice: string }>("/api/vault/unlock/pin", { pin });

export const requestOtp = (purpose: "vault_unlock" | "pin_reset") =>
  apiPost<{ notice: string }>("/api/vault/otp", { purpose });

export const unlockWithOtp = (code: string) =>
  apiPost<{ notice: string }>("/api/vault/unlock/otp", { code });

export const lockVault = () => apiPost<{ ok: boolean }>("/api/vault/lock");

export const lockAllVaultSessions = () => apiPost<{ ok: boolean }>("/api/vault/lock-all");

export type ApiVaultSession = {
  id: string;
  method: string;
  ip: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
};

export const listVaultSessions = () =>
  apiGet<{ sessions: ApiVaultSession[] }>("/api/vault/sessions");

export const disableRecovery = (confirm: string) =>
  apiDelete<{ notice: string }>("/api/vault/recovery", { confirm });

export const listSecrets = (owner?: { accountId?: string | null; projectId?: string | null }) =>
  apiGet<{ secrets: SecretSummary[] }>("/api/vault/secrets", {
    account_id: owner?.accountId ?? undefined,
    project_id: owner?.projectId ?? undefined,
  });

export const putSecret = (body: {
  kind: string;
  tier: "server" | "personal";
  value: string;
  label?: string | null;
  account_id?: string | null;
  project_id?: string | null;
}) => apiPost<{ id: string; notice: string }>("/api/vault/secrets", body);

export const revealSecret = (id: string) =>
  apiPost<{ value: string }>(`/api/vault/secrets/${id}/reveal`);

export const deleteSecret = (id: string) =>
  apiDelete<{ ok: boolean }>(`/api/vault/secrets/${id}`);

export const listAudit = (limit = 100) =>
  apiGet<{ entries: AuditRow[] }>("/api/vault/audit", { limit });
