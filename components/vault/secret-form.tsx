"use client";

import { useActionState } from "react";
import { LockIcon, ServerIcon } from "lucide-react";
import { saveSecret, removeSecret } from "@/app/vault/actions";
import type { SecretKind } from "@/lib/vault/secrets";
import type { SecretTier } from "@/lib/crypto/secrets";
import { SubmitButton } from "@/components/buttons";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RevealField } from "@/components/vault/reveal-field";

export type SecretSlot = {
  kind: SecretKind;
  label: string;
  help: string;
  tier: SecretTier;
  /** Id of the stored row, when one exists. */
  existingId?: string | null;
};

/**
 * One row per credential a provider asks for. Shows what's stored, lets it be revealed after
 * an unlock, and lets it be replaced.
 */
export function SecretSlots({
  slots,
  accountId,
  projectId,
  unlocked,
  vaultReady,
}: {
  slots: SecretSlot[];
  accountId?: string | null;
  projectId?: string | null;
  unlocked: boolean;
  vaultReady: boolean;
}) {
  if (!vaultReady) {
    return (
      <p className="text-muted-foreground text-xs">
        Set up a vault PIN on the Vault page to start storing passwords here.
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      {slots.map((slot) => (
        <SecretRow
          key={slot.kind}
          slot={slot}
          accountId={accountId}
          projectId={projectId}
          unlocked={unlocked}
        />
      ))}
    </div>
  );
}

function SecretRow({
  slot,
  accountId,
  projectId,
  unlocked,
}: {
  slot: SecretSlot;
  accountId?: string | null;
  projectId?: string | null;
  unlocked: boolean;
}) {
  const [state, action] = useActionState(saveSecret, null);
  const personal = slot.tier === "personal";
  const inputId = `secret-${slot.kind}`;

  return (
    <div className="grid gap-2 border-b pb-4 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.8125rem] font-medium">{slot.label}</span>
        <Badge variant={personal ? "success" : "muted"} title={
          personal
            ? "Encrypted with your PIN. The server can't read it unattended."
            : "The nightly sweep needs this, so the server can decrypt it without you present."
        }>
          {personal ? <LockIcon aria-hidden /> : <ServerIcon aria-hidden />}
          {personal ? "Personal" : "Server"}
        </Badge>
        {slot.existingId && <Badge variant="outline">Stored</Badge>}
      </div>

      <p className="text-muted-foreground text-xs">{slot.help}</p>

      {slot.existingId && (
        <RevealField
          secretId={slot.existingId}
          label={slot.label}
          disabled={!unlocked}
          disabledReason="Unlock your vault to reveal this."
        />
      )}

      <form action={action} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <input type="hidden" name="kind" value={slot.kind} />
        <input type="hidden" name="tier" value={slot.tier} />
        {accountId && <input type="hidden" name="account_id" value={accountId} />}
        {projectId && <input type="hidden" name="project_id" value={projectId} />}

        <Field
          label={slot.existingId ? "Replace with" : "Value"}
          htmlFor={inputId}
          error={state?.error ?? null}
        >
          <Input
            id={inputId}
            name="value"
            type="password"
            autoComplete="off"
            placeholder={slot.existingId ? "•••••••• (leave blank to keep)" : ""}
          />
        </Field>

        <SubmitButton
          size="sm"
          variant="outline"
          pending="Saving…"
          disabled={personal && !unlocked}
        >
          Save
        </SubmitButton>
      </form>

      {personal && !unlocked && (
        <p className="text-muted-foreground text-xs">
          Unlock your vault to store this — it&apos;s encrypted with your PIN, so the server
          needs your key to seal it.
        </p>
      )}

      {state?.notice && (
        <p role="status" className="text-accent text-xs">
          {state.notice}
        </p>
      )}

      {slot.existingId && (
        <form action={removeSecret}>
          <input type="hidden" name="secret_id" value={slot.existingId} />
          <SubmitButton
            variant="ghost"
            size="sm"
            confirm={`Delete the stored ${slot.label.toLowerCase()}? This can't be undone.`}
          >
            Delete stored value
          </SubmitButton>
        </form>
      )}
    </div>
  );
}
