import Link from "next/link";
import { listAccounts, listProjects } from "@/lib/db";
import { ProjectBoard, type BoardProject } from "@/components/project-board";
import { SubmitButton } from "@/components/buttons";
import { pingAll } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const [projects, accounts] = await Promise.all([listProjects(), listAccounts()]);

  // Keys never leave the server.
  const board: BoardProject[] = projects.map(({ anon_key, ...p }) => ({ ...p, has_key: !!anon_key }));

  const usedByAccount = new Map<string, number>();
  for (const p of projects) if (p.account_id) usedByAccount.set(p.account_id, (usedByAccount.get(p.account_id) ?? 0) + 1);
  const freeAccounts = accounts.filter((a) => (usedByAccount.get(a.id) ?? 0) < 2);
  const keepAlive = projects.filter((p) => p.keep_alive).length;
  const failing = projects.filter((p) => p.keep_alive && p.last_status === "error").length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="muted" style={{ margin: 0 }}>
            Paste a project URL, ref, or your whole <code>.env</code> to find which account owns it.
          </p>
        </div>
        <form action={pingAll}>
          <SubmitButton className="btn btn-ghost" pending="Pinging…">Ping all now</SubmitButton>
        </form>
      </div>

      <div className="grid stats">
        <div className="card stat"><div className="n">{accounts.length}</div><div className="l">Accounts</div></div>
        <div className="card stat"><div className="n">{projects.length}</div><div className="l">Projects</div></div>
        <div className="card stat"><div className="n">{keepAlive}</div><div className="l">Kept alive</div></div>
        <div className="card stat">
          <div className={`n ${failing ? "text-err" : ""}`}>{failing}</div>
          <div className="l">Failing pings</div>
        </div>
        <div className="card stat">
          <div className="n">{freeAccounts.reduce((n, a) => n + 2 - (usedByAccount.get(a.id) ?? 0), 0)}</div>
          <div className="l">
            Free slots{" "}
            {freeAccounts[0] && <>· next: <Link href="/accounts">{freeAccounts[0].label ?? freeAccounts[0].email}</Link></>}
          </div>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="card">
          <h2>Start by adding your Supabase accounts</h2>
          <p className="muted">Add each email you use to log into Supabase, then add the projects under them.</p>
          <Link href="/accounts" className="btn">Add an account</Link>
        </div>
      ) : (
        <ProjectBoard projects={board} />
      )}
    </>
  );
}
