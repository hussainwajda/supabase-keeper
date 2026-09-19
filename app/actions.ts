"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { SESSION_COOKIE, createSessionToken, safeEqual, verifySessionToken } from "@/lib/auth";
import { db, type Project } from "@/lib/db";
import { extractRef } from "@/lib/ref";
import { pingProject, pingProjects } from "@/lib/ping";

async function requireAuth() {
  const jar = await cookies();
  if (!(await verifySessionToken(jar.get(SESSION_COOKIE)?.value))) redirect("/login");
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

// ---------- auth ----------

export async function login(_: string | null, fd: FormData): Promise<string | null> {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return "APP_PASSWORD is not configured on the server.";
  if (!safeEqual(str(fd, "password") ?? "", expected)) return "Wrong password.";
  const { token, expires } = await createSessionToken();
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", expires });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

// ---------- accounts ----------

export async function saveAccount(fd: FormData) {
  await requireAuth();
  const id = str(fd, "id");
  const row = {
    email: str(fd, "email"),
    label: str(fd, "label"),
    login_method: str(fd, "login_method"),
    notes: str(fd, "notes"),
  };
  if (!row.email) throw new Error("Email is required");
  const q = id ? db().from("accounts").update(row).eq("id", id) : db().from("accounts").insert(row);
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
  const ref = extractRef(str(fd, "ref") ?? "");
  if (!ref) return "Couldn't find a project ref. Paste the project URL (https://<ref>.supabase.co) or the 20-char ref.";

  const anonKey = str(fd, "anon_key");
  if (anonKey && (anonKey.startsWith("sb_secret_") || looksLikeServiceRole(anonKey))) {
    return "That looks like a service_role / secret key. Only store the anon or publishable key here.";
  }

  const row: Partial<Project> = {
    name: str(fd, "name") ?? ref,
    ref,
    account_id: str(fd, "account_id"),
    keep_alive: fd.get("keep_alive") === "on",
    repo_url: str(fd, "repo_url"),
    local_path: str(fd, "local_path"),
    notes: str(fd, "notes"),
  };
  // Keep-alive fields are hidden when the toggle is off, and a blank key means "keep the saved one".
  if (anonKey) row.anon_key = anonKey;
  if (fd.has("ping_table")) row.ping_table = str(fd, "ping_table");
  if (fd.has("interval_days")) row.interval_days = Math.min(30, Math.max(1, Number(str(fd, "interval_days")) || 5));

  const { error } = id
    ? await db().from("projects").update(row).eq("id", id)
    : await db().from("projects").insert(row);
  if (error) return error.code === "23505" ? `A project with ref ${ref} already exists.` : error.message;

  revalidatePath("/", "layout");
  redirect("/");
}

function looksLikeServiceRole(key: string): boolean {
  if (!key.startsWith("eyJ")) return false;
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString());
    return payload.role === "service_role";
  } catch {
    return false;
  }
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
