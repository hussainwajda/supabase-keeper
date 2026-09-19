import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type Account = {
  id: string;
  email: string;
  label: string | null;
  login_method: string | null;
  notes: string | null;
  created_at: string;
};

export type Project = {
  id: string;
  account_id: string | null;
  name: string;
  ref: string;
  anon_key: string | null;
  ping_table: string | null;
  keep_alive: boolean;
  interval_days: number;
  repo_url: string | null;
  local_path: string | null;
  notes: string | null;
  last_pinged_at: string | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  created_at: string;
};

export type ProjectWithAccount = Project & { account: Account | null };

export type PingLog = {
  id: number;
  project_id: string;
  status: string;
  http_status: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
};

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export async function listAccounts(): Promise<Account[]> {
  const { data, error } = await db().from("accounts").select("*").order("created_at");
  if (error) throw error;
  return data;
}

export async function listProjects(): Promise<ProjectWithAccount[]> {
  const { data, error } = await db().from("projects").select("*, account:accounts(*)").order("name");
  if (error) throw error;
  return data as ProjectWithAccount[];
}

export async function getProject(id: string): Promise<ProjectWithAccount | null> {
  const { data, error } = await db().from("projects").select("*, account:accounts(*)").eq("id", id).maybeSingle();
  if (error) throw error;
  return data as ProjectWithAccount | null;
}

export async function recentLogs(projectId: string, limit = 15): Promise<PingLog[]> {
  const { data, error } = await db()
    .from("ping_logs")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}
