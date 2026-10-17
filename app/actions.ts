"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { SESSION_COOKIE, createSessionToken, safeEqual, verifySessionToken } from "@/lib/auth";
import { db, forWrite, type Project } from "@/lib/registry";
import { getProvider, parseIdentifier } from "@/lib/providers/registry";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/types";
import { pingProject, pingProjects } from "@/lib/ping";

async function requireAuth() {
  const jar = await cookies();
  if (!(await verifySessionToken(jar.get(SESSION_COOKIE)?.value))) redirect("/login");
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

function asProvider(value: string | null): ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId) ? (value as ProviderId) : "supabase";
}

// ---------- auth ----------

export async function login(_: string | null, fd: FormData): Promise<string | null> {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return "APP_PASSWORD is not configured on the server.";
  if (!safeEqual(str(fd, "password") ?? "", expected)) return "Wrong password.";
  const { token, expires } = await createSessionToken();
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires,
  });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

// ---------- search ----------

/**
 * Paste-anything parsing, run on the server so every adapter's `parse()` stays server-side.
 * Called from the board's search box as the user types.
 */
export async function parsePastedIdentifier(input: string) {
  await requireAuth();
  return parseIdentifier(input);
}

// ---------- accounts ----------

export async function saveAccount(fd: FormData) {
  await requireAuth();
  const id = str(fd, "id");
  const row = {
    provider: asProvider(str(fd, "provider")),
    email: str(fd, "email"),
    label: str(fd, "label"),
    login_method: str(fd, "login_method"),
    notes: str(fd, "notes"),
  };
  if (!row.email) throw new Error("Email is required");
  const payload = await forWrite("accounts", row as Record<string, unknown>);
  const q = id
    ? db().from("accounts").update(payload).eq("id", id)
    : db().from("accounts").insert(payload);
  const { error } = await q;
  if (error) throw error;
  revalidatePath("/", "layout");
}

export async function deleteAccount(fd: FormData) {
  await requireAuth();
  const { error } = await db().from("accounts").delete().eq("id", str(fd, "id"));
  if (error) throw error;
  revalidatePath("/", "layout");
}

// ---------- projects ----------

export async function saveProject(_: string | null, fd: FormData): Promise<string | null> {
  await requireAuth();
  const id = str(fd, "id");
  const provider = asProvider(str(fd, "provider"));
  const adapter = getProvider(provider);

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

  const row: Partial<Project> & Record<string, unknown> = {
    provider,
    external_id: externalId,
    // Keep the legacy column in sync until migration 0006 drops it.
    ref: provider === "supabase" ? externalId : null,
    name: str(fd, "name") ?? externalId,
    account_id: str(fd, "account_id"),
    strategy: adapter.policy.strategy,
    keep_alive: fd.get("keep_alive") === "on",
    repo_url: str(fd, "repo_url"),
    local_path: str(fd, "local_path"),
    notes: str(fd, "notes"),
  };

  // Keep-alive fields are hidden when the toggle is off, and a blank key means "keep the saved one".
  const anonKey = str(fd, "anon_key");
  if (anonKey) row.anon_key = anonKey;
  if (fd.has("ping_table")) row.ping_table = str(fd, "ping_table");
  if (fd.has("interval_days")) {
    row.interval_days = Math.min(
      60,
      Math.max(1, Number(str(fd, "interval_days")) || adapter.policy.defaultIntervalDays),
    );
  }

  const payload = await forWrite("projects", row);
  const { error } = id
    ? await db().from("projects").update(payload).eq("id", id)
    : await db().from("projects").insert(payload);
  if (error) {
    return error.code === "23505"
      ? `A ${adapter.name} project with identifier ${externalId} already exists.`
      : error.message;
  }

  revalidatePath("/", "layout");
  redirect("/");
}

export async function deleteProject(fd: FormData) {
  await requireAuth();
  const { error } = await db().from("projects").delete().eq("id", str(fd, "id"));
  if (error) throw error;
  revalidatePath("/", "layout");
  redirect("/");
}

export async function pingNow(fd: FormData) {
  await requireAuth();
  const { data, error } = await db().from("projects").select("*").eq("id", str(fd, "id")).single();
  if (error) throw error;
  await pingProject(data as Project);
  revalidatePath("/", "layout");
}

export async function pingAll() {
  await requireAuth();
  await pingProjects({ force: true });
  revalidatePath("/", "layout");
}
