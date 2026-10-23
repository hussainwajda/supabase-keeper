"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { currentUser } from "@/lib/backend/user";
import { forWrite, type Project } from "@/lib/registry";
import { claimLegacyRows } from "@/lib/registry/claim";
import { getProvider, parseIdentifier } from "@/lib/providers/registry";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/types";
import { pingProject, pingProjects } from "@/lib/ping";
import { putSecret } from "@/lib/vault/secrets";
import { vaultConfigured } from "@/lib/crypto/env";
import { usingNodeBackend } from "@/lib/backend/env";
import { ApiError } from "@/lib/backend/client";
import * as api from "@/lib/backend/api";
import { setFlash } from "@/lib/flash-server";

/**
 * Turn an API failure into the string these actions already return.
 *
 * The forms render a returned string as inline validation and let a thrown error become an
 * error boundary, so a 400 from the API has to come back as a value rather than a throw —
 * otherwise "that isn't a valid project URL" would blow up the page instead of appearing
 * under the field. A 5xx is a genuine fault and is left to throw.
 */
function asFormError(e: unknown): string {
  if (e instanceof ApiError && e.status < 500) return e.message;
  throw e;
}

/**
 * Every action starts here. Returns the user id, so writes can stamp ownership — RLS would
 * reject a row whose `user_id` doesn't match the caller anyway, but setting it explicitly is
 * what makes the insert succeed in the first place.
 */
async function requireUser(): Promise<string> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user.id;
}

/** Id and email, for the few actions that need to check who is acting. */
async function requireIdentity(): Promise<{ id: string; email: string | null }> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return { id: user.id, email: user.email ?? null };
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

function asProvider(value: string | null): ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId) ? (value as ProviderId) : "supabase";
}

// ---------- search ----------

/**
 * Paste-anything parsing, run on the server so every adapter's `parse()` stays server-side.
 * Called from the board's search box as the user types.
 */
export async function parsePastedIdentifier(input: string) {
  await requireUser();
  // Parsing lives in the adapters either way; on the Node backend they're the same four files
  // running in that process, so the answer is identical and the round trip buys consistency
  // rather than correctness.
  if (usingNodeBackend()) return (await api.parseIdentifier(input)).parsed;
  return parseIdentifier(input);
}

// ---------- legacy claim ----------

export async function claimLegacy() {
  if (usingNodeBackend()) {
    throw new Error(
      "There is nothing to claim on the Node backend: ownership comes across with the migration, so no document can be unowned.",
    );
  }
  const { id, email } = await requireIdentity();
  await claimLegacyRows(id, email);
  await setFlash("Existing rows claimed", "success");
  revalidatePath("/", "layout");
}

// ---------- accounts ----------

export async function saveAccount(fd: FormData) {
  const userId = await requireUser();

  if (usingNodeBackend()) {
    const id = str(fd, "id");
    const body = {
      provider: asProvider(str(fd, "provider")),
      email: str(fd, "email"),
      label: str(fd, "label"),
      login_method: str(fd, "login_method"),
      notes: str(fd, "notes"),
    };
    if (!body.email) throw new Error("Email is required");
    if (id) await api.updateAccount(id, body);
    else await api.createAccount(body);
    await setFlash(id ? "Account updated" : "Account added", "success", body.email ?? undefined);
    revalidatePath("/", "layout");
    return;
  }

  const db = await supabaseServer();
  const id = str(fd, "id");

  const row = {
    user_id: userId,
    provider: asProvider(str(fd, "provider")),
    email: str(fd, "email"),
    label: str(fd, "label"),
    login_method: str(fd, "login_method"),
    notes: str(fd, "notes"),
  };
  if (!row.email) throw new Error("Email is required");

  const payload = await forWrite("accounts", row as Record<string, unknown>);
  const { error } = id
    ? await db.from("accounts").update(payload).eq("id", id)
    : await db.from("accounts").insert(payload);
  if (error) throw error;

  await setFlash(id ? "Account updated" : "Account added", "success", row.email ?? undefined);
  revalidatePath("/", "layout");
}

export async function deleteAccount(fd: FormData) {
  await requireUser();

  if (usingNodeBackend()) {
    await api.deleteAccount(str(fd, "id") ?? "");
    await setFlash("Account deleted", "success");
    revalidatePath("/", "layout");
    return;
  }

  const db = await supabaseServer();
  const { error } = await db.from("accounts").delete().eq("id", str(fd, "id"));
  if (error) throw error;
  await setFlash("Account deleted", "success");
  revalidatePath("/", "layout");
}

// ---------- projects ----------

export async function saveProject(_: string | null, fd: FormData): Promise<string | null> {
  const userId = await requireUser();

  if (usingNodeBackend()) {
    const id = str(fd, "id");
    const anonKey = str(fd, "anon_key");

    /*
     * The adapter's `parse()` and its field validators both run on the API side, so they
     * aren't repeated here — that's the point of the contract being identical. What this does
     * is shape the form into a body and translate a 4xx back into inline text.
     *
     * `metadata` carries `ping_table` as an explicit null when cleared, because the API merges
     * metadata rather than replacing it; without the null the key would survive a deletion.
     */
    const body: Record<string, unknown> = {
      provider: asProvider(str(fd, "provider")),
      external_id: str(fd, "external_id") ?? "",
      name: str(fd, "name"),
      account_id: str(fd, "account_id"),
      keep_alive: fd.get("keep_alive") === "on",
      repo_url: str(fd, "repo_url"),
      local_path: str(fd, "local_path"),
      notes: str(fd, "notes"),
    };
    if (fd.has("ping_table")) body.metadata = { ping_table: str(fd, "ping_table") };
    if (fd.has("interval_days")) body.interval_days = Number(str(fd, "interval_days"));
    // Only the fields the adapter declared; the API validates them.
    for (const field of getProvider(body.provider as ProviderId).projectFields) {
      const value = str(fd, field.key);
      if (value && field.key !== "anon_key") body[field.key] = value;
    }

    let projectId: string;
    try {
      projectId = id
        ? (await api.updateProject(id, body)).project.id
        : (await api.createProject(body)).project.id;
    } catch (e) {
      return asFormError(e);
    }

    if (anonKey) {
      try {
        await api.putSecret({
          kind: "anon_key",
          tier: "server",
          value: anonKey,
          project_id: projectId,
        });
      } catch (e) {
        // The project saved; only the key didn't. Say so rather than failing silently.
        return `Project saved, but the key couldn't be stored: ${(e as Error).message}`;
      }
    }

    await setFlash("Project saved", "success");
    revalidatePath("/", "layout");
    redirect("/");
  }

  const db = await supabaseServer();
  const id = str(fd, "id");
  const provider = asProvider(str(fd, "provider"));
  const adapter = getProvider(provider);

  // Needed for the metadata merge below.
  const existing = id
    ? (await db.from("projects").select("metadata").eq("id", id).maybeSingle()).data
    : null;

  const rawId = str(fd, "external_id") ?? "";
  const parsed = adapter.parse(rawId);
  if (!parsed) {
    return `Couldn't find a ${adapter.name} project identifier in that. Paste the project URL or the identifier itself.`;
  }
  const externalId = parsed.externalId;

  // Run the adapter's own validators, so every provider gets the same "you pasted the wrong
  // key" protection the Supabase anon-key check used to provide on its own.
  for (const field of adapter.projectFields) {
    const value = str(fd, field.key);
    if (value && field.validate) {
      const problem = field.validate(value);
      if (problem) return problem;
    }
  }

  // `ping_table` lives in metadata now (its column was dropped by 0006). Merge rather than
  // replace, so provider-specific keys discovery wrote there survive an edit from this form.
  const metadata: Record<string, unknown> = { ...(existing?.metadata ?? {}) };
  if (fd.has("ping_table")) {
    const table = str(fd, "ping_table");
    if (table) metadata.ping_table = table;
    else delete metadata.ping_table;
  }

  const row: Partial<Project> & Record<string, unknown> = {
    user_id: userId,
    provider,
    external_id: externalId,
    metadata,
    name: str(fd, "name") ?? externalId,
    account_id: str(fd, "account_id"),
    strategy: adapter.policy.strategy,
    keep_alive: fd.get("keep_alive") === "on",
    repo_url: str(fd, "repo_url"),
    local_path: str(fd, "local_path"),
    notes: str(fd, "notes"),
  };

  // A blank key means "keep the saved one". Keys always go to the vault now; `forWrite`
  // strips `anon_key` for registries that have run 0006, and the pre-0006 fallback below
  // keeps older registries working.
  const anonKey = str(fd, "anon_key");
  const anonKeyToVault = anonKey && vaultConfigured();
  if (anonKey && !anonKeyToVault) row.anon_key = anonKey;
  if (fd.has("interval_days")) {
    row.interval_days = Math.min(
      60,
      Math.max(1, Number(str(fd, "interval_days")) || adapter.policy.defaultIntervalDays),
    );
  }

  const payload = await forWrite("projects", row);
  const { error } = id
    ? await db.from("projects").update(payload).eq("id", id)
    : await db.from("projects").insert(payload);
  if (error) {
    return error.code === "23505"
      ? `A ${adapter.name} project with identifier ${externalId} already exists.`
      : error.message;
  }

  if (anonKeyToVault) {
    // Needs the row id, so this happens after the insert/update.
    const projectId =
      id ??
      (
        await db
          .from("projects")
          .select("id")
          .eq("provider", provider)
          .eq("external_id", externalId)
          .single()
      ).data?.id;

    if (projectId) {
      try {
        await putSecret(userId, { projectId }, "anon_key", "server", anonKey!);
      } catch (e) {
        // The project saved; only the key didn't. Say so rather than failing silently.
        return `Project saved, but the key couldn't be stored: ${(e as Error).message}`;
      }
    }
  }

  await setFlash("Project saved", "success");
  revalidatePath("/", "layout");
  redirect("/");
}

export async function deleteProject(fd: FormData) {
  await requireUser();

  if (usingNodeBackend()) {
    await api.deleteProject(str(fd, "id") ?? "");
    await setFlash("Project deleted", "success");
    revalidatePath("/", "layout");
    redirect("/");
  }

  const db = await supabaseServer();
  const { error } = await db.from("projects").delete().eq("id", str(fd, "id"));
  if (error) throw error;
  await setFlash("Project deleted", "success");
  revalidatePath("/", "layout");
  redirect("/");
}

/**
 * Report a ping the way the ping itself came back.
 *
 * A failed ping is not an exception — it's a result, and the old code discarded it either
 * way, so pressing Ping on a broken project looked identical to pressing it on a healthy one.
 */
async function flashPingResult(result: {
  status?: unknown;
  name?: unknown;
  error?: unknown;
  via?: unknown;
}): Promise<void> {
  const name = typeof result.name === "string" ? result.name : "Project";
  if (result.status === "ok") {
    await setFlash(
      `${name} pinged`,
      "success",
      typeof result.via === "string" ? result.via : undefined,
    );
    return;
  }
  await setFlash(
    `${name} could not be pinged`,
    "error",
    typeof result.error === "string" ? result.error : undefined,
  );
}

export async function pingNow(fd: FormData) {
  await requireUser();

  if (usingNodeBackend()) {
    // The API routes by the provider's strategy, so a `watch` provider gets a usage read
    // rather than a ping it would be wrong to claim.
    const { result } = await api.pingProject(str(fd, "id") ?? "");
    await flashPingResult(result);
    revalidatePath("/", "layout");
    return;
  }

  const db = await supabaseServer();
  // Selected through the user client, so RLS makes it impossible to ping someone else's
  // project by guessing an id.
  const { data, error } = await db.from("projects").select("*").eq("id", str(fd, "id")).single();
  if (error) throw error;
  const result = await pingProject(data as Project);
  await flashPingResult(result);
  revalidatePath("/", "layout");
}

/** "3 pinged" is useful; "3 pinged, 1 failed" is the part you actually need to see. */
function sweepSummary(results: { status?: unknown }[]): { message: string; failed: number } {
  const failed = results.filter((r) => r.status !== "ok").length;
  const ok = results.length - failed;
  const plural = (n: number) => (n === 1 ? "project" : "projects");
  if (results.length === 0) return { message: "Nothing was due for a ping", failed: 0 };
  if (failed === 0) return { message: `Pinged ${ok} ${plural(ok)}`, failed };
  return { message: `Pinged ${ok} ${plural(ok)}, ${failed} failed`, failed };
}

export async function pingAll() {
  const userId = await requireUser();

  if (usingNodeBackend()) {
    const { results } = await api.pingAll();
    const { message, failed } = sweepSummary(results);
    await setFlash(message, failed ? "error" : "success");
    revalidatePath("/", "layout");
    return;
  }

  const results = await pingProjects({ force: true, userId });
  const { message, failed } = sweepSummary(results);
  await setFlash(message, failed ? "error" : "success");
  revalidatePath("/", "layout");
}
