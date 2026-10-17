"use client";

import { useActionState } from "react";
import { ShieldOffIcon } from "lucide-react";
import { turnOffRecovery } from "@/app/vault/actions";
import { SubmitButton } from "@/components/buttons";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";

export function RecoveryToggle({ enabled, unlocked }: { enabled: boolean; unlocked: boolean }) {
  const [state, action] = useActionState(turnOffRecovery, null);

  if (!enabled) {
    return (
      <div className="grid gap-1">
        <p className="text-[0.8125rem]">
          <strong className="font-medium">Email recovery is off.</strong> Your PIN is the only
          way to read your personal secrets. Not even the server operator can decrypt them.
        </p>
        <p className="text-muted-foreground text-xs">
          This can&apos;t be switched back on: re-enabling it would mean handing the server a
          copy of your key, which is exactly what you turned off.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="grid gap-3">
      <p className="text-[0.8125rem]">
        Right now a copy of your key is wrapped by the server&apos;s master key, so an emailed
        code can unlock your vault if you forget your PIN. The cost: whoever holds{" "}
        <strong className="font-medium">both</strong> this deployment&apos;s database and its
        environment can decrypt your personal secrets.
      </p>
      <p className="text-muted-foreground text-xs">
        Turning recovery off deletes that copy. Forget the PIN afterwards and those secrets are
        gone permanently — for everyone, including us. Server-tier credentials (provider API
        keys) are unaffected; the sweep still needs to read those unattended.
      </p>

      <Field
        label='Type "no recovery" to confirm'
        htmlFor="confirm-recovery"
        error={state?.error ?? null}
      >
        <Input id="confirm-recovery" name="confirm" autoComplete="off" placeholder="no recovery" />
      </Field>

      {state?.notice && (
        <p role="status" className="text-accent text-[0.8125rem]">
          {state.notice}
        </p>
      )}

      <div>
        <SubmitButton variant="destructive" size="sm" pending="Applying…" disabled={!unlocked}>
          <ShieldOffIcon aria-hidden />
          Turn off email recovery
        </SubmitButton>
      </div>
      {!unlocked && <p className="text-muted-foreground text-xs">Unlock the vault first.</p>}
    </form>
  );
}
