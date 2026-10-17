import Link from "next/link";
import { listAccounts, listProjects, slotsUsed, type Account } from "@/lib/registry";
import { activeProviders } from "@/lib/providers/registry";
import { deleteAccount, saveAccount } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ProviderBadge } from "@/components/providers/provider-badge";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const LOGIN_METHODS = ["GitHub", "Google", "Email + password", "Magic link", "SSO"];

function AccountFields({ a, providers }: { a?: Account; providers: { id: string; name: string }[] }) {
  const uid = a?.id ?? "new";
  return (
    <>
      {a && <input type="hidden" name="id" value={a.id} />}

      <Field label="Provider" htmlFor={`provider-${uid}`}>
        <select
          id={`provider-${uid}`}
          name="provider"
          defaultValue={a?.provider ?? "supabase"}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/40 h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Email" htmlFor={`email-${uid}`}>
          <Input
            id={`email-${uid}`}
            name="email"
            type="email"
            defaultValue={a?.email}
            required
            placeholder="you+side@gmail.com"
          />
        </Field>
        <Field label="Label" htmlFor={`label-${uid}`} hint="Optional nickname">
          <Input
            id={`label-${uid}`}
            name="label"
            defaultValue={a?.label ?? ""}
            placeholder="Side-projects #2"
          />
        </Field>
        <Field label="How do you log in?" htmlFor={`login-${uid}`}>
          <Input
            id={`login-${uid}`}
            name="login_method"
            list="login-methods"
            defaultValue={a?.login_method ?? ""}
            placeholder="GitHub (@handle)"
          />
        </Field>
      </div>

      <Field
        label="Notes"
        htmlFor={`notes-${uid}`}
        hint="No passwords here — the encrypted vault arrives in Phase 2."
      >
        <Input id={`notes-${uid}`} name="notes" defaultValue={a?.notes ?? ""} />
      </Field>
    </>
  );
}

export default async function AccountsPage() {
  const [accounts, projects] = await Promise.all([listAccounts(), listProjects()]);
  const providers = activeProviders().map((a) => ({ id: a.id, name: a.name }));
  const used = slotsUsed(projects);

  return (
    <>
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Accounts</h1>
        <p className="text-muted-foreground text-[0.8125rem]">
          Each login you use at a database provider. Free Supabase accounts get 2 active projects.
        </p>
      </div>

      <datalist id="login-methods">
        {LOGIN_METHODS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <div className="mb-6 grid gap-3 lg:grid-cols-2">
        {accounts.map((a) => {
          const owned = projects.filter((p) => p.account_id === a.id);
          const isSupabase = a.provider === "supabase";
          const over = isSupabase && owned.length > 2;

          return (
            <Card key={a.id}>
              <CardContent className="grid gap-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="grid gap-1">
                    <strong className="break-all">{a.email}</strong>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ProviderBadge provider={a.provider} />
                      {a.label && (
                        <span className="text-muted-foreground text-xs">{a.label}</span>
                      )}
                      {a.login_method && <Badge variant="muted">{a.login_method}</Badge>}
                    </div>
                  </div>

                  {isSupabase && (
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1" title={`${owned.length}/2 free slots used`}>
                        {[0, 1].map((i) => (
                          <span
                            key={i}
                            className={cn(
                              "size-2 rounded-full",
                              i < owned.length ? "bg-accent" : "bg-muted-foreground/30",
                            )}
                          />
                        ))}
                      </div>
                      <span className={cn("text-xs", over ? "text-warning" : "text-muted-foreground")}>
                        {owned.length}/2
                      </span>
                    </div>
                  )}
                </div>

                {a.notes && <p className="text-muted-foreground text-xs">{a.notes}</p>}

                {owned.length > 0 && (
                  <ul className="grid gap-0.5 text-[0.8125rem]">
                    {owned.map((p) => (
                      <li key={p.id} className="flex items-center gap-2">
                        <Link
                          href={`/projects/${p.id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {p.name}
                        </Link>
                        <code className="text-muted-foreground font-mono text-xs">
                          {p.external_id}
                        </code>
                      </li>
                    ))}
                  </ul>
                )}

                <details className="mt-1">
                  <summary className="text-muted-foreground cursor-pointer text-xs">Edit</summary>
                  <form action={saveAccount} className="mt-3 grid gap-3">
                    <AccountFields a={a} providers={providers} />
                    <div>
                      <SubmitButton size="sm" pending="Saving…">
                        Save
                      </SubmitButton>
                    </div>
                  </form>
                  <form action={deleteAccount} className="mt-3">
                    <input type="hidden" name="id" value={a.id} />
                    <SubmitButton
                      variant="destructive"
                      size="sm"
                      confirm={`Delete ${a.email}? Its projects stay but become unassigned.`}
                    >
                      Delete account
                    </SubmitButton>
                  </form>
                </details>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardContent className="grid gap-3">
          <h2 className="text-base font-semibold">Add account</h2>
          <form action={saveAccount} className="grid gap-3">
            <AccountFields providers={providers} />
            <div>
              <SubmitButton pending="Adding…">Add account</SubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
