import { notFound } from "next/navigation";
import { getProject, listAccounts, listProjects, recentLogs } from "@/lib/db";
import { ProjectForm } from "@/components/project-form";
import { SubmitButton } from "@/components/buttons";
import { KEEP_ALIVE_SQL } from "@/lib/keep-alive-sql";
import { dashboardUrl } from "@/lib/ref";
import { deleteProject, pingNow } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [project, accounts, projects, logs] = await Promise.all([getProject(id), listAccounts(), listProjects(), recentLogs(id)]);
  if (!project) notFound();

  const slotsUsed: Record<string, number> = {};
  for (const p of projects) if (p.account_id) slotsUsed[p.account_id] = (slotsUsed[p.account_id] ?? 0) + 1;
  const { anon_key, account: _account, ...rest } = project;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{project.name}</h1>
          <div className="muted">
            <code>{project.ref}</code> · {project.account ? <>owned by <strong>{project.account.email}</strong>
            {project.account.login_method && <> (log in with {project.account.login_method})</>}</> : "unassigned"}
          </div>
        </div>
        <div className="inline">
          <a className="btn btn-ghost" href={dashboardUrl(project.ref)} target="_blank" rel="noreferrer">Open in Supabase ↗</a>
          <form action={pingNow}>
            <input type="hidden" name="id" value={project.id} />
            <SubmitButton pending="Pinging…">Ping now</SubmitButton>
          </form>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", alignItems: "start" }}>
        <div className="card">
          <ProjectForm
            accounts={accounts}
            slotsUsed={slotsUsed}
            project={{ ...rest, has_key: !!anon_key }}
            keepAliveSql={KEEP_ALIVE_SQL}
          />
        </div>

        <div className="grid">
          <div className="card table-wrap">
            <h2>Recent pings</h2>
            {logs.length === 0 ? (
              <p className="muted">No pings yet.</p>
            ) : (
              <table>
                <thead><tr><th>When</th><th>Result</th><th>ms</th></tr></thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id}>
                      <td className="small">{new Date(l.created_at).toLocaleString()}</td>
                      <td className="small">
                        <span className={`dot ${l.status}`} />
                        {l.http_status ?? "—"}
                        {l.error && <div className="text-err">{l.error.slice(0, 160)}</div>}
                      </td>
                      <td className="small muted">{l.duration_ms}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="card">
            <form action={deleteProject}>
              <input type="hidden" name="id" value={project.id} />
              <SubmitButton className="btn btn-danger btn-sm" confirm={`Remove ${project.name} from the registry? (Doesn't touch Supabase.)`}>
                Remove from registry
              </SubmitButton>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}
