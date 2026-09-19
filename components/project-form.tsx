"use client";

import { useActionState, useState } from "react";
import type { Account, Project } from "@/lib/db";
import { saveProject } from "@/app/actions";
import { CopyButton, SubmitButton } from "@/components/buttons";

type Props = {
  accounts: Account[];
  slotsUsed: Record<string, number>;
  project?: Omit<Project, "anon_key"> & { has_key: boolean };
  defaultRef?: string;
  keepAliveSql: string;
};

export function ProjectForm({ accounts, slotsUsed, project, defaultRef, keepAliveSql }: Props) {
  const [error, action] = useActionState(saveProject, null);
  const [keepAlive, setKeepAlive] = useState(project?.keep_alive ?? true);

  return (
    <form action={action} className="form">
      {project && <input type="hidden" name="id" value={project.id} />}

      <div className="row2">
        <label>
          Project name
          <input name="name" defaultValue={project?.name} placeholder="habit-tracker" required />
        </label>
        <label>
          Supabase URL or ref
          <input
            name="ref"
            defaultValue={project?.ref ?? defaultRef}
            placeholder="https://abcdefghijklmnopqrst.supabase.co"
            required
          />
        </label>
      </div>

      <label>
        Account
        <select name="account_id" defaultValue={project?.account_id ?? ""}>
          <option value="">— Unassigned —</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
              {a.label ? ` (${a.label})` : ""} — {slotsUsed[a.id] ?? 0}/2 used
            </option>
          ))}
        </select>
      </label>

      <div className="row2">
        <label>
          Repo URL <span className="hint">optional — helps search</span>
          <input name="repo_url" defaultValue={project?.repo_url ?? ""} placeholder="https://github.com/you/habit-tracker" />
        </label>
        <label>
          Local folder <span className="hint">optional</span>
          <input name="local_path" defaultValue={project?.local_path ?? ""} placeholder="~/code/habit-tracker" />
        </label>
      </div>

      <label>
        Notes
        <textarea name="notes" rows={2} defaultValue={project?.notes ?? ""} />
      </label>

      <fieldset className="card" style={{ margin: 0 }}>
        <label className="inline" style={{ display: "flex" }}>
          <input type="checkbox" name="keep_alive" checked={keepAlive} onChange={(e) => setKeepAlive(e.target.checked)} />
          Keep this project alive (auto-ping)
        </label>

        {keepAlive && (
          <div className="form" style={{ marginTop: 12 }}>
            <label>
              Anon / publishable key
              <span className="hint">
                Project Settings → API. Never paste the service_role / secret key.
                {project?.has_key && " Leave blank to keep the saved key."}
              </span>
              <input
                name="anon_key"
                placeholder={project?.has_key ? "•••••••• (saved)" : "eyJhbGciOi… or sb_publishable_…"}
                autoComplete="off"
              />
            </label>
            <div className="row2">
              <label>
                Ping table
                <span className="hint">real DB query; blank = auth health check only</span>
                <input name="ping_table" defaultValue={project?.ping_table ?? "keep_alive"} />
              </label>
              <label>
                Ping every (days)
                <span className="hint">free projects pause after 7 idle days — 5 leaves margin</span>
                <input name="interval_days" type="number" min={1} max={30} defaultValue={project?.interval_days ?? 5} />
              </label>
            </div>
            <details>
              <summary className="small muted">SQL to create the keep_alive table in this project</summary>
              <pre className="sql">{keepAliveSql}</pre>
              <CopyButton text={keepAliveSql} label="Copy SQL" />
            </details>
          </div>
        )}
      </fieldset>

      {error && <div className="error">{error}</div>}
      <div>
        <SubmitButton pending="Saving…">{project ? "Save changes" : "Add project"}</SubmitButton>
      </div>
    </form>
  );
}
