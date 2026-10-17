"use client";

import { useActionState } from "react";
import { setupPin, updatePin } from "@/app/vault/actions";
import { SubmitButton } from "@/components/buttons";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";

export function PinSetup({ mode, unlocked }: { mode: "create" | "change"; unlocked: boolean }) {
  const [state, action] = useActionState(mode === "create" ? setupPin : updatePin, null);

  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={mode === "create" ? "Choose a PIN" : "New PIN"}
          htmlFor="pin"
          hint="4 to 8 digits."
        >
          <Input
            id="pin"
            name="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            required
            minLength={4}
            maxLength={8}
            pattern="\d{4,8}"
            className="font-mono tracking-[0.2em]"
          />
        </Field>
        <Field label="Confirm" htmlFor="confirm" error={state?.error ?? null}>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            required
            minLength={4}
            maxLength={8}
            pattern="\d{4,8}"
            className="font-mono tracking-[0.2em]"
          />
        </Field>
      </div>

      {state?.notice && (
        <p role="status" className="text-accent text-[0.8125rem]">
          {state.notice}
        </p>
      )}

      <div>
        <SubmitButton pending="Saving…" disabled={mode === "change" && !unlocked}>
          {mode === "create" ? "Set vault PIN" : "Change PIN"}
        </SubmitButton>
      </div>

      {mode === "change" && !unlocked && (
        <p className="text-muted-foreground text-xs">
          Unlock the vault first. Changing the PIN re-wraps your existing key, so the vault has
          to be open — otherwise every stored secret would be orphaned.
        </p>
      )}
    </form>
  );
}
