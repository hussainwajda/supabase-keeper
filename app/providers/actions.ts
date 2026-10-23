"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/backend/user";
import { supabaseService } from "@/lib/supabase/service";
import { getProvider } from "@/lib/providers/registry";
import { applySync, planSync, recordSyncFailure, type SyncPlan } from "@/lib/providers/sync";
import { resolveServerCredentials } from "@/lib/vault/resolve";
import { audit } from "@/lib/vault/audit";
import { toProjectRef } from "@/lib/ping";
import type { Project } from "@/lib/registry";
import type { ConnectionStrings, HealthReport, ProviderId } from "@/lib/providers/types";
import { usingNodeBackend } from "@/lib/backend/env";
import * as api from "@/lib/backend/api";


async function requireUser(): Promise<string> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user.id;
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Load a project the signed-in user owns. RLS does the authorising. */
async function ownedProject(userId: string, projectId: string): Promise<Project> {
  const { data, error } = await supabaseService()
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new Error("That project doesn't exist, or isn't yours.");
  return data as Project;
}

export type SyncState = { plan: SyncPlan | null; error: string | null; applied: string | null };

/** Preview a sync. Reads only — nothing is written until the plan is confirmed. */
export async function previewSync(_: SyncState | null, fd: FormData): Promise<SyncState> {
  const userId = await requireUser();
  const accountId = str(fd, "account_id");
  const provider = str(fd, "provider") as ProviderId;

  try {
    const plan = usingNodeBackend()
      ? await api.previewSync(accountId, provider).then((r) => r.plan)
      : await planSync(userId, accountId, provider);
    return { plan, error: null, applied: null };
  } catch (e) {
    const message = (e as Error).message;
    await recordSyncFailure(accountId, message);
    revalidatePath("/accounts");
    return { plan: null, error: message, applied: null };
  }
}

/** Apply a previewed sync. Re-plans server-side so a stale preview can't write stale values. */
export async function confirmSync(_: SyncState | null, fd: FormData): Promise<SyncState> {
  const userId = await requireUser();
  const accountId = str(fd, "account_id");
  const provider = str(fd, "provider") as ProviderId;

  try {
    if (usingNodeBackend()) {
      const { notice } = await api.applySync(accountId, provider, {
        adopt: fd.get("adopt") === "on",
        fetchKeys: fd.get("fetch_keys") === "on",
      });
      revalidatePath("/", "layout");
      return { plan: null, error: null, applied: notice };
    }

    const result = await applySync(userId, accountId, provider, {
      adoptReassigned: fd.get("adopt") === "on",
      fetchCredentials: fd.get("fetch_keys") === "on",
    });

    const parts = [
      result.created && `imported ${result.created}`,
      result.updated && `updated ${result.updated}`,
      result.reassigned && `moved ${result.reassigned}`,
      result.keysFetched && `fetched ${result.keysFetched} key${result.keysFetched === 1 ? "" : "s"}`,
    ].filter(Boolean);

    revalidatePath("/", "layout");
    return {
      plan: null,
      error: null,
      applied: parts.length ? `Synced: ${parts.join(", ")}.` : "Already in step — nothing to change.",
    };
  } catch (e) {
    const message = (e as Error).message;
    await recordSyncFailure(accountId, message);
    revalidatePath("/accounts");
    return { plan: null, error: message, applied: null };
  }
}

export type ActionNotice = { error: string | null; notice: string | null };

/** Un-pause a project through the provider's API. */
export async function restoreProject(
  _: ActionNotice | null,
  fd: FormData,
): Promise<ActionNotice> {
  const userId = await requireUser();
  const projectId = str(fd, "project_id");

  try {
    if (usingNodeBackend()) {
      const { notice } = await api.restoreProject(projectId);
      revalidatePath("/", "layout");
      return { error: null, notice };
    }

    const project = await ownedProject(userId, projectId);
    const adapter = getProvider(project.provider);
    if (!adapter.revive) {
      return {
        error: `${adapter.name} can't be restored from Keepstack — open its console.`,
        notice: null,
      };
    }

    const credentials = await resolveServerCredentials(userId, {
      accountId: project.account_id,
      projectId: project.id,
    });
    await adapter.revive(toProjectRef(project), credentials);

    // Restoring is asynchronous at the provider; reflect the in-between state rather than
    // claiming it is already back.
    await supabaseService()
      .from("projects")
      .update({ lifecycle: "idle", provider_status: "RESTORING", last_error: null })
      .eq("id", project.id);

    await audit(userId, {
      action: "secret.migrated",
      targetType: "project",
      targetId: project.id,
      detail: { event: "project.restore_requested", provider: project.provider },
    });

    revalidatePath("/", "layout");
    return {
      error: null,
      notice: "Restore requested. Supabase takes a few minutes; refresh to see the new status.",
    };
  } catch (e) {
    return { error: (e as Error).message, notice: null };
  }
}

/** Re-read one project's status from the provider. */
export async function refreshStatus(fd: FormData) {
  const userId = await requireUser();

  if (usingNodeBackend()) {
    // A failed status read is not worth surfacing; the next sweep retries. The API already
    // answers 200 with `stale: true` in that case, so there is nothing to catch here.
    await api.refreshStatus(str(fd, "project_id")).catch(() => undefined);
    revalidatePath("/", "layout");
    return;
  }

  const project = await ownedProject(userId, str(fd, "project_id"));
  const adapter = getProvider(project.provider);
  if (!adapter.status) return;

  const credentials = await resolveServerCredentials(userId, {
    accountId: project.account_id,
    projectId: project.id,
  });

  try {
    const { lifecycle, raw } = await adapter.status(toProjectRef(project), credentials);
    await supabaseService()
      .from("projects")
      .update({ lifecycle, provider_status: raw })
      .eq("id", project.id);
  } catch {
    // A status read failing is not worth surfacing as an error state; the next sweep retries.
  }

  revalidatePath("/", "layout");
}

/** Fetch per-service health on demand. Not stored — it's a point-in-time reading. */
export async function fetchHealth(projectId: string): Promise<HealthReport[]> {
  const userId = await requireUser();

  if (usingNodeBackend()) {
    return api.fetchHealth(projectId).then((r) => r.health).catch(() => []);
  }

  const project = await ownedProject(userId, projectId);
  const adapter = getProvider(project.provider);
  if (!adapter.health) return [];

  const credentials = await resolveServerCredentials(userId, {
    accountId: project.account_id,
    projectId: project.id,
  });

  try {
    return await adapter.health(toProjectRef(project), credentials);
  } catch {
    return [];
  }
}

/**
 * Pull the provider's own copy of a project's credentials (Supabase anon keys, Upstash REST
 * tokens) so the user doesn't paste them by hand.
 */
export async function fetchProjectKeys(
  _: ActionNotice | null,
  fd: FormData,
): Promise<ActionNotice> {
  const userId = await requireUser();

  try {
    if (usingNodeBackend()) {
      const { notice } = await api.fetchProjectKeys(str(fd, "project_id"));
      revalidatePath("/", "layout");
      return { error: null, notice };
    }

    const project = await ownedProject(userId, str(fd, "project_id"));
    const adapter = getProvider(project.provider);
    if (!adapter.fetchProjectCredentials) {
      return { error: `${adapter.name} doesn't expose its keys over an API.`, notice: null };
    }

    const credentials = await resolveServerCredentials(userId, {
      accountId: project.account_id,
      projectId: project.id,
    });
    // Which account credential this needs is the adapter's business, not this action's:
    // Supabase wants a PAT, Upstash an email *and* an API key. Hardcoding `pat` here meant
    // any other provider's key fetch failed with advice about a token it never asked for.
    const missing = adapter.accountFields
      .filter((f) => f.tier === "server" && !credentials[f.key])
      .map((f) => f.label.toLowerCase());
    if (missing.length > 0) {
      return {
        error: `Add this account's ${missing.join(" and ")} first — that's what Keepstack asks ${adapter.name} with.`,
        notice: null,
      };
    }

    const fetched = await adapter.fetchProjectCredentials(toProjectRef(project), credentials);
    const kinds = Object.keys(fetched);
    if (kinds.length === 0) {
      return { error: "The provider returned no usable keys for this project.", notice: null };
    }

    const { putSecret } = await import("@/lib/vault/secrets");
    for (const [kind, value] of Object.entries(fetched)) {
      await putSecret(userId, { projectId: project.id }, kind, "server", value, "Fetched from the provider");
    }

    revalidatePath("/", "layout");
    return { error: null, notice: `Stored ${kinds.join(", ")}, encrypted.` };
  } catch (e) {
    return { error: (e as Error).message, notice: null };
  }
}

export type ConnectionStringState = {
  pooled: string | null;
  direct: string | null;
  /** The provider's names for the pair; see `ConnectionStrings.labels`. */
  labels?: ConnectionStrings["labels"];
  error: string | null;
};

/**
 * Assemble `DATABASE_URL` / `DIRECT_URL` from the stored database password.
 *
 * The password is `personal` tier, so this needs an unlocked vault — and the assembled
 * strings contain it in clear, which is why they are returned to the user and never stored.
 */
export async function buildConnectionStrings(
  _: ConnectionStringState | null,
  fd: FormData,
): Promise<ConnectionStringState> {
  const userId = await requireUser();

  try {
    if (usingNodeBackend()) {
      // The assembled strings contain the database password in clear, which is why the API
      // returns them and never stores them — and why this needs the vault open at that end.
      const strings = await api.connectionStrings(str(fd, "project_id"));
      return { ...strings, error: null };
    }

    const project = await ownedProject(userId, str(fd, "project_id"));
    const adapter = getProvider(project.provider);
    if (!adapter.connectionStrings) {
      return { pooled: null, direct: null, error: `${adapter.name} has no connection strings.` };
    }

    const { currentDek } = await import("@/lib/vault/session");
    const dek = await currentDek(userId);
    if (!dek) {
      return { pooled: null, direct: null, error: "Unlock your vault first." };
    }

    const { data } = await supabaseService()
      .from("secrets")
      .select("ciphertext, tier, kind")
      .eq("user_id", userId)
      .eq("project_id", project.id)
      .eq("kind", "db_password")
      .maybeSingle();

    if (!data) {
      return {
        pooled: null,
        direct: null,
        error: "No database password saved for this project. Add one under Credentials.",
      };
    }

    const { openPersonalSecret, openServerSecret } = await import("@/lib/crypto/secrets");
    const password =
      data.tier === "personal"
        ? openPersonalSecret(data.ciphertext as string, dek, userId, "db_password")
        : openServerSecret(data.ciphertext as string, userId, "db_password");

    if (!password) {
      return { pooled: null, direct: null, error: "That password couldn't be decrypted." };
    }

    const strings = adapter.connectionStrings(toProjectRef(project), { db_password: password });

    await audit(userId, {
      action: "secret.reveal",
      targetType: "project",
      targetId: project.id,
      detail: { kind: "db_password", purpose: "connection_strings" },
    });

    return { ...strings, error: null };
  } catch (e) {
    return { pooled: null, direct: null, error: (e as Error).message };
  }
}

/** Read a `watch` provider's usage on demand. */
export async function refreshUsage(fd: FormData) {
  const userId = await requireUser();

  if (usingNodeBackend()) {
    await api.refreshUsage(str(fd, "project_id"));
    revalidatePath("/", "layout");
    return;
  }

  const project = await ownedProject(userId, str(fd, "project_id"));
  const { captureUsage } = await import("@/lib/usage");
  await captureUsage(project);
  revalidatePath("/", "layout");
}
