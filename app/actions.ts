"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseServer, currentUser } from "@/lib/supabase/server";
import { forWrite, type Project } from "@/lib/registry";
import { claimLegacyRows } from "@/lib/registry/claim";
import { getProvider, parseIdentifier } from "@/lib/providers/registry";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/types";
import { pingProject, pingProjects } from "@/lib/ping";
import { putSecret } from "@/lib/vault/secrets";
import { vaultConfigured } from "@/lib/crypto/env";

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
  return parseIdentifier(input);
}

// ---------- legacy claim ----------

export async function claimLegacy() {
  const { id, email } = await requireIdentity();
  await claimLegacyRows(id, email);
  revalidatePath("/", "layout");
}

// ---------- accounts ----------

export async function saveAccount(fd: FormData) {
  const userId = await requireUser();
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

  revalidatePath("/", "layout");
}

export async function deleteAccount(fd: FormData) {
  await requireUser();
  const db = await supabaseServer();
  const { error } = await db.from("accounts").delete().eq("id", str(fd, "id"));
  if (error) throw error;
  revalidatePath("/", "layout");
}

// ---------- projects ----------

export async function saveProject(_: string | null, fd: FormData): Promise<string | null> {
  const userId = await requireUser();
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

  revalidatePath("/", "layout");
  redirect("/");
}

export async function deleteProject(fd: FormData) {
  await requireUser();
  const db = await supabaseServer();
  const { error } = await db.from("projects").delete().eq("id", str(fd, "id"));
  if (error) throw error;
  revalidatePath("/", "layout");
  redirect("/");
}

export async function pingNow(fd: FormData) {
  await requireUser();
  const db = await supabaseServer();
  // Selected through the user client, so RLS makes it impossible to ping someone else's
  // project by guessing an id.
  const { data, error } = await db.from("projects").select("*").eq("id", str(fd, "id")).single();
  if (error) throw error;
  await pingProject(data as Project);
  revalidatePath("/", "layout");
}

export async function pingAll() {
  const userId = await requireUser();
  await pingProjects({ force: true, userId });
  revalidatePath("/", "layout");
}
