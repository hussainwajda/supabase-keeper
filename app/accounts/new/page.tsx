import { activeProviders } from "@/lib/providers/registry";
import { saveAccount } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";

export const dynamic = "force-dynamic";

const LOGIN_METHODS = ["GitHub", "Google", "Email + password", "Magic link", "SSO"];

export default async function NewAccountPage() {
  const providers = activeProviders().map((a) => ({ id: a.id, name: a.name }));

  return (
    <>
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Add account</h1>
        <p className="text-muted-foreground text-[0.8125rem]">
          Register a provider login so Keepstack knows which account owns which projects.
        </p>
      </div>

      <datalist id="login-methods">
        {LOGIN_METHODS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <Card className="max-w-3xl">
        <CardContent className="grid gap-3">
          <form action={saveAccount} className="grid gap-4">
            <Field label="Provider" htmlFor="provider-new">
              <select
                id="provider-new"
                name="provider"
                defaultValue="supabase"
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
              <Field label="Email" htmlFor="email-new">
                <Input
                  id="email-new"
                  name="email"
                  type="email"
                  required
                  placeholder="you+side@gmail.com"
                />
              </Field>
              <Field label="Label" htmlFor="label-new" hint="Optional nickname">
                <Input
                  id="label-new"
                  name="label"
                  placeholder="Side-projects #2"
                />
              </Field>
              <Field label="How do you log in?" htmlFor="login-new">
                <Input
                  id="login-new"
                  name="login_method"
                  list="login-methods"
                  placeholder="GitHub (@handle)"
                />
              </Field>
            </div>

            <Field
              label="Notes"
              htmlFor="notes-new"
              hint="Plain text, visible to you only. Passwords belong under Credentials, where they are encrypted."
            >
              <Input id="notes-new" name="notes" />
            </Field>

            <div>
              <SubmitButton pending="Adding…">Add account</SubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
