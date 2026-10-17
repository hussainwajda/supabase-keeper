"use client";

import { useActionState } from "react";
import { DatabaseZapIcon } from "lucide-react";
import { login } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";

export default function LoginPage() {
  const [error, action] = useActionState(login, null);

  return (
    <div className="mx-auto mt-[12vh] max-w-sm">
      <Card>
        <CardContent className="grid gap-4">
          <div className="grid gap-1">
            <DatabaseZapIcon className="text-accent size-5" aria-hidden />
            <h1 className="text-lg font-semibold tracking-tight">Sign in to Keepstack</h1>
            <p className="text-muted-foreground text-[0.8125rem]">
              Enter the APP_PASSWORD you set in your environment.
            </p>
          </div>

          <form action={action} className="grid gap-3">
            <Field label="Password" htmlFor="password" error={error}>
              <Input id="password" type="password" name="password" autoFocus required autoComplete="current-password" />
            </Field>
            <SubmitButton pending="Signing in…">Sign in</SubmitButton>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
