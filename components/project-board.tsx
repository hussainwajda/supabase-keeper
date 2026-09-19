"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ProjectWithAccount } from "@/lib/db";
import { dashboardUrl, extractRef } from "@/lib/ref";
import { daysUntilPauseRisk, nextPingLabel, timeAgo } from "@/lib/format";
import { pingNow } from "@/app/actions";
import { CopyButton, SubmitButton } from "@/components/buttons";

export type BoardProject = Omit<ProjectWithAccount, "anon_key"> & { has_key: boolean };

export function ProjectBoard({ projects }: { projects: BoardProject[] }) {
  const [q, setQ] = useState("");
  const ref = useMemo(() => extractRef(q), [q]);
  const exact = ref ? projects.find((p) => p.ref === ref) : undefined;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return projects;
    if (ref) return projects.filter((p) => p.ref === ref);
    return projects.filter((p) =>
      [p.name, p.ref, p.repo_url, p.local_path, p.notes, p.account?.email, p.account?.label]
        .some((f) => f?.toLowerCase().includes(needle)),
    );
  }, [projects, q, ref]);

  return (
    <>
      <div className="search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onPaste={(e) => {
            // Pasting a multi-line .env into a single-line input: keep only what we need.
            const text = e.clipboardData.getData("text");
            if (text.includes("\n")) {
              e.preventDefault();
              setQ(extractRef(text) ?? text.replace(/\s+/g, " ").slice(0, 200));
            }
          }}
          placeholder="Search by name, repo, account… or paste https://xxxx.supabase.co / a .env file"
          autoFocus
        />
        {q && <button className="btn btn-ghost" onClick={() => setQ("")}>Clear</button>}
      </div>

      {exact && (
        <div className="match">
          <div className="muted small">
            <code>{exact.ref}</code> belongs to
          </div>
          {exact.account ? (
            <>
              <div className="who inline">
                {exact.account.email} <CopyButton text={exact.account.email} />
              </div>
              <div className="muted">
                {exact.account.label && <>{exact.account.label} · </>}
                Log in with: <strong>{exact.account.login_method ?? "not recorded"}</strong>
              </div>
            </>
          ) : (
            <div className="who text-warn">No account assigned yet</div>
          )}
          <div className="inline" style={{ marginTop: 10 }}>
            <strong>{exact.name}</strong>
            <a className="btn btn-sm" href={dashboardUrl(exact.ref)} target="_blank" rel="noreferrer">Open dashboard ↗</a>
            <Link className="btn btn-ghost btn-sm" href={`/projects/${exact.id}`}>Details</Link>
          </div>
        </div>
      )}

      {ref && !exact && (
        <div className="match" style={{ borderColor: "var(--warn)" }}>
          <div className="who">
            <code>{ref}</code> isn&apos;t in your registry yet.
          </div>
          <p className="muted">
            Log into each account until you find it, then save it here so you never have to search again.
          </p>
          <Link className="btn btn-sm" href={`/projects/new?ref=${ref}`}>Add this project</Link>
        </div>
      )}

      <div className="card table-wrap" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Account</th>
              <th>Keep-alive</th>
              <th className="hide-sm">Last ping</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {projects.length ? "No matches." : <>No projects yet. <Link href="/projects/new">Add one</Link>.</>}
                </td>
              </tr>
            )}
            {filtered.map((p) => {
              const risk = daysUntilPauseRisk(p.last_pinged_at);
              return (
                <tr key={p.id}>
                  <td>
                    <Link href={`/projects/${p.id}`}><strong>{p.name}</strong></Link>
                    <div className="mono muted">{p.ref}</div>
                    {p.repo_url && <div className="small muted">{p.repo_url.replace(/^https?:\/\//, "")}</div>}
                  </td>
                  <td>
                    {p.account ? (
                      <>
                        <div>{p.account.email}</div>
                        {p.account.login_method && <span className="chip">{p.account.login_method}</span>}
                      </>
                    ) : (
                      <span className="text-warn">Unassigned</span>
                    )}
                  </td>
                  <td>
                    {p.keep_alive ? (
                      <>
                        <span className={`dot ${p.last_status ?? ""}`} />
                        every {p.interval_days}d
                        <div className="small muted" suppressHydrationWarning>
                          next: {nextPingLabel(p.last_pinged_at, p.interval_days, true)}
                        </div>
                        {!p.has_key && <div className="small text-err">missing anon key</div>}
                      </>
                    ) : (
                      <span className="muted">off</span>
                    )}
                  </td>
                  <td className="hide-sm">
                    <span suppressHydrationWarning>{timeAgo(p.last_pinged_at)}</span>
                    {p.last_status === "error" && (
                      <div className="small text-err" title={p.last_error ?? ""}>
                        {(p.last_error ?? "error").slice(0, 60)}
                      </div>
                    )}
                    {p.keep_alive && risk !== null && risk < 2 && (
                      <div className="small text-warn" suppressHydrationWarning>
                        pause risk in {Math.max(0, risk).toFixed(1)}d
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="actions">
                      <form action={pingNow}>
                        <input type="hidden" name="id" value={p.id} />
                        <SubmitButton className="btn btn-ghost btn-sm" pending="…">Ping</SubmitButton>
                      </form>
                      <a className="btn btn-ghost btn-sm" href={dashboardUrl(p.ref)} target="_blank" rel="noreferrer">↗</a>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
