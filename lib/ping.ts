import "server-only";
import { db, type Project } from "@/lib/db";

const DAY_MS = 24 * 60 * 60 * 1000;
// Cron runs daily at a fixed time; allow slack so a project due "in 23h50m" isn't skipped a whole day.
const DUE_SLACK_MS = 2 * 60 * 60 * 1000;

export type PingResult = {
  projectId: string;
  name: string;
  status: "ok" | "error";
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
};

export function isDue(p: Project, now = Date.now()): boolean {
  if (!p.keep_alive) return false;
  if (!p.last_pinged_at) return true;
  return now - new Date(p.last_pinged_at).getTime() >= p.interval_days * DAY_MS - DUE_SLACK_MS;
}

/**
 * Hit the project's REST API with its anon key. With a ping table this runs a real
 * `select ... limit 1` against Postgres, which is what counts as activity.
 */
async function hit(p: Project): Promise<Omit<PingResult, "projectId" | "name">> {
  const base = `https://${p.ref}.supabase.co`;
  const started = Date.now();
  if (!p.anon_key) {
    return { status: "error", httpStatus: null, durationMs: 0, error: "No anon/publishable key saved for this project" };
  }

  const headers: Record<string, string> = { apikey: p.anon_key };
  // Legacy anon keys are JWTs and go in Authorization too; new sb_publishable_ keys must not.
  if (p.anon_key.startsWith("eyJ")) headers.Authorization = `Bearer ${p.anon_key}`;

  const url = p.ping_table
    ? `${base}/rest/v1/${encodeURIComponent(p.ping_table)}?select=*&limit=1`
    : `${base}/auth/v1/health`;

  try {
    const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const durationMs = Date.now() - started;
    if (res.ok) return { status: "ok", httpStatus: res.status, durationMs, error: null };

    let body = (await res.text()).slice(0, 300);
    if (res.status === 404 && p.ping_table) {
      body = `Table "${p.ping_table}" not found — run supabase/keep_alive.sql in this project. ${body}`;
    }
    if (res.status === 540 || /paused/i.test(body)) {
      body = `Project appears to be PAUSED — restore it from the dashboard. ${body}`;
    }
    return { status: "error", httpStatus: res.status, durationMs, error: body || res.statusText };
  } catch (e) {
    return { status: "error", httpStatus: null, durationMs: Date.now() - started, error: (e as Error).message };
  }
}

export async function pingProject(p: Project): Promise<PingResult> {
  const r = await hit(p);
  const now = new Date().toISOString();
  await Promise.all([
    db()
      .from("projects")
      .update({ last_pinged_at: now, last_status: r.status, last_error: r.error })
      .eq("id", p.id),
    db().from("ping_logs").insert({
      project_id: p.id,
      status: r.status,
      http_status: r.httpStatus,
      duration_ms: r.durationMs,
      error: r.error,
    }),
  ]);
  return { projectId: p.id, name: p.name, ...r };
}

/** Ping every keep-alive project (only due ones unless `force`). Used by the cron and "Ping all". */
export async function pingProjects({ force = false } = {}): Promise<PingResult[]> {
  const { data, error } = await db().from("projects").select("*").eq("keep_alive", true);
  if (error) throw error;
  const targets = (data as Project[]).filter((p) => force || isDue(p));
  const results = await Promise.all(targets.map(pingProject));

  // Housekeeping: keep 90 days of logs.
  await db().from("ping_logs").delete().lt("created_at", new Date(Date.now() - 90 * DAY_MS).toISOString());
  return results;
}
