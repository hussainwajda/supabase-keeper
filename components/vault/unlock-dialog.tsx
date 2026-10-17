"use client";

import { useActionState, useState } from "react";
import { KeyRoundIcon, LockOpenIcon, MailIcon } from "lucide-react";
import { requestOtp, unlockWithOtp, unlockWithPin } from "@/app/vault/actions";
import { SubmitButton } from "@/components/buttons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";

type Tab = "pin" | "otp";

export function UnlockDialog({
  otpEnabled,
  lockedUntil,
  triggerLabel = "Unlock vault",
  triggerVariant = "default",
}: {
  otpEnabled: boolean;
  lockedUntil: string | null;
  triggerLabel?: string;
  triggerVariant?: "default" | "outline" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  // When the PIN is locked out, email is the only way in — so start there.
  const [tab, setTab] = useState<Tab>(lockedUntil && otpEnabled ? "otp" : "pin");

  const [pinState, pinAction] = useActionState(unlockWithPin, null);
  const [otpState, otpAction] = useActionState(unlockWithOtp, null);
  const [sendState, sendAction] = useActionState(requestOtp, null);

  const state = tab === "pin" ? pinState : (otpState ?? sendState);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size="sm">
          <LockOpenIcon aria-hidden />
          {triggerLabel}
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Unlock your vault</DialogTitle>
          <DialogDescription>
            Being signed in isn&apos;t enough to read a stored password. This opens a 10-minute
            window, and every reveal is written to your audit log.
          </DialogDescription>
        </DialogHeader>

        {otpEnabled && (
          <div className="bg-muted grid grid-cols-2 gap-1 rounded-md p-1">
            <Button
              type="button"
              variant={tab === "pin" ? "default" : "ghost"}
              size="sm"
              onClick={() => setTab("pin")}
            >
              <KeyRoundIcon aria-hidden />
              PIN
            </Button>
            <Button
              type="button"
              variant={tab === "otp" ? "default" : "ghost"}
              size="sm"
              onClick={() => setTab("otp")}
            >
              <MailIcon aria-hidden />
              Email code
            </Button>
          </div>
        )}

        {tab === "pin" ? (
          <form action={pinAction} className="grid gap-3">
            <Field label="Vault PIN" htmlFor="unlock-pin" error={pinState?.error ?? null}>
              <Input
                id="unlock-pin"
                name="pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                required
                placeholder="••••••"
                className="text-center font-mono tracking-[0.3em]"
              />
            </Field>
            <SubmitButton pending="Checking…">Unlock</SubmitButton>
          </form>
        ) : (
          <div className="grid gap-3">
            <form action={sendAction}>
              <input type="hidden" name="purpose" value="vault_unlock" />
              <SubmitButton variant="outline" size="sm" className="w-full" pending="Sending…">
                <MailIcon aria-hidden />
                Email me a code
              </SubmitButton>
            </form>

            <form action={otpAction} className="grid gap-3">
              <Field
                label="6-digit code"
                htmlFor="unlock-otp"
                hint="Expires in 10 minutes, usable once."
                error={otpState?.error ?? null}
              >
                <Input
                  id="unlock-otp"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  placeholder="000000"
                  className="text-center font-mono text-lg tracking-[0.4em]"
                />
              </Field>
              <SubmitButton pending="Checking…">Unlock</SubmitButton>
            </form>
          </div>
        )}

        {state?.notice && (
          <p role="status" className="text-accent text-[0.8125rem]">
            {state.notice}
          </p>
        )}
        {tab === "otp" && sendState?.error && (
          <p role="alert" className="text-destructive text-[0.8125rem]">
            {sendState.error}
          </p>
        )}
        {!otpEnabled && (
          <p className="text-muted-foreground text-xs">
            Email codes aren&apos;t configured on this deployment, so the PIN is the only way in.
            Set <code className="font-mono">RESEND_API_KEY</code> to enable recovery.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
