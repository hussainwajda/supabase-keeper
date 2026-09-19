import Link from "next/link";
import { listAccounts, listProjects, type Account } from "@/lib/db";
import { deleteAccount, saveAccount } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";

export const dynamic = "force-dynamic";

const LOGIN_METHODS = ["GitHub", "Google", "Email + password", "Magic link", "SSO"];

function AccountFields({ a }: { a?: Account }) {
  return (
    <>
      {a && <input type="hidden" name="id" value={a.id} />}
      <div className="row2">
        <label>
          Email
          <input name="email" type="email" defaultValue={a?.email} required placeholder="you+side@gmail.com" />
        </label>
        <label>
          Label <span className="hint">optional nickname</span>
          <input name="label" defaultValue={a?.label ?? ""} placeholder="Side-projects #2" />
        </label>
        <label>
          How do you log in?
          <input name="login_method" list="login-methods" defaultValue={a?.login_method ?? ""} placeholder="GitHub (@handle)" />
        </label>
      </div>
      <label>
        Notes <span className="hint">no passwords here — use a password manager</span>
        <input name="notes" defaultValue={a?.notes ?? ""} />
      </label>
    </>
  );
}

export default async function AccountsPage() {
  const [accounts, projects] = await Promise.all([listAccounts(), listProjects()]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Accounts</h1>
          <p className="muted" style={{ margin: 0 }}>Each free Supabase account gets 2 active projects.</p>
        </div>
      </div>

      <datalist id="login-methods">
        {LOGIN_METHODS.map((m) => <option key={m} value={m} />)}
      </datalist>

      <div className="grid" style={{ marginBottom: 24 }}>
        {accounts.map((a) => {
          const owned = projects.filter((p) => p.account_id === a.id);
          return (
            <div className="card" key={a.id}>
              <div className="inline" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                <div>
                  <strong>{a.email}</strong>
                  {a.label && <span className="muted"> · {a.label}</span>}
                  {a.login_method && <> <span className="chip">{a.login_method}</span></>}
                </div>
                <div className="inline">
                  <div className="slots" title={`${owned.length}/2 free slots used`}>
                    {[0, 1].map((i) => <span key={i} className={`slot ${i < owned.length ? "used" : ""}`} />)}
                  </div>
                  <span className={`small ${owned.length > 2 ? "text-warn" : "muted"}`}>{owned.length}/2</span>
                </div>
              </div>
              {a.notes && <p className="small muted" style={{ margin: "6px 0 0" }}>{a.notes}</p>}
              {owned.length > 0 && (
                <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {owned.map((p) => (
                    <li key={p.id}>
                      <Link href={`/projects/${p.id}`}>{p.name}</Link> <span className="mono muted">{p.ref}</span>
                    </li>
                  ))}
                </ul>
              )}
              <details style={{ marginTop: 10 }}>
                <summary className="small muted">Edit</summary>
                <form action={saveAccount} className="form" style={{ marginTop: 10 }}>
                  <AccountFields a={a} />
                  <div className="inline">
                    <SubmitButton pending="Saving…">Save</SubmitButton>
                  </div>
                </form>
                <form action={deleteAccount} style={{ marginTop: 8 }}>
                  <input type="hidden" name="id" value={a.id} />
                  <SubmitButton
                    className="btn btn-danger btn-sm"
                    confirm={`Delete ${a.email}? Its projects stay but become unassigned.`}
                  >
                    Delete account
                  </SubmitButton>
                </form>
              </details>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h2>Add account</h2>
        <form action={saveAccount} className="form">
          <AccountFields />
          <div>
            <SubmitButton pending="Adding…">Add account</SubmitButton>
          </div>
        </form>
      </div>
    </>
  );
}
