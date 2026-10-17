"use client";

import { useActionState, useState } from "react";
import type { Account, SafeProject } from "@/lib/registry/types";
import type { ProviderId } from "@/lib/providers/types";
import type { ProviderOption } from "@/lib/providers/options";
import { saveProject } from "@/app/actions";
import { CopyButton, SubmitButton } from "@/components/buttons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { PROVIDER_LABEL, StrategyBadge } from "@/components/providers/provider-badge";

type Props = {
  accounts: Account[];
  slotsUsed: Record<string, number>;
  providers: ProviderOption[];
  project?: SafeProject;
  defaultProvider?: ProviderId;
  defaultExternalId?: string;
  keepAliveSql: string;
};

export function ProjectForm({
  accounts,
  slotsUsed,
  providers,
  project,
  defaultProvider,
  defaultExternalId,
  keepAliveSql,
}: Props) {
  const [error, action] = useActionState(saveProject, null);
  const [providerId, setProviderId] = useState<ProviderId>(
    project?.provider ?? defaultProvider ?? providers[0]?.id ?? "supabase",
  );
  const provider = providers.find((p) => p.id === providerId) ?? providers[0];
  const [keepAlive, setKeepAlive] = useState(project?.keep_alive ?? true);

  // Only offer accounts that belong to the selected provider — a Neon project can't live
  // under a Supabase login.
  const eligibleAccounts = accounts.filter((a) => a.provider === providerId);
  const canPing = provider.policy.strategy === "ping";

  return (
    <form action={action} className="grid gap-4">
      {project && <input type="hidden" name="id" value={project.id} />}
      <input type="hidden" name="provider" value={providerId} />

      {/* Provider is fixed once a project exists: changing it would invalidate every stored
          credential and the identifier format. */}
      {project ? (
        <div className="flex items-center gap-2">
          <Label>Provider</Label>
          <Badge variant="outline">{PROVIDER_LABEL[providerId]}</Badge>
          <StrategyBadge policy={provider.policy} />
        </div>
      ) : (
        <Field label="Provider" hint={provider.policy.summary}>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Provider">
            {providers.map((p) => (
              <Button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={p.id === providerId}
                variant={p.id === providerId ? "default" : "outline"}
                size="sm"
                onClick={() => setProviderId(p.id)}
              >
                {p.name}
              </Button>
            ))}
          </div>
        </Field>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Project name" htmlFor="name">
          <Input id="name" name="name" defaultValue={project?.name} placeholder="habit-tracker" required />
        </Field>
        <Field label={provider.identifierLabel} htmlFor="external_id" hint={provider.identifierHint}>
          <Input
            id="external_id"
            name="external_id"
            defaultValue={project?.external_id ?? defaultExternalId}
            placeholder={provider.identifierPlaceholder}
            required
            className="font-mono"
          />
        </Field>
      </div>

      <Field
        label="Account"
        htmlFor="account_id"
        hint={
          eligibleAccounts.length === 0
            ? `No ${provider.name} accounts yet — add one on the Accounts page.`
            : undefined
        }
      >
        <select
          id="account_id"
          name="account_id"
          defaultValue={project?.account_id ?? ""}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/40 h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
        >
          <option value="">— Unassigned —</option>
          {eligibleAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
              {a.label ? ` (${a.label})` : ""}
              {providerId === "supabase" ? ` — ${slotsUsed[a.id] ?? 0}/2 used` : ""}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Repo URL" htmlFor="repo_url" hint="Optional — helps search find it later">
          <Input
            id="repo_url"
            name="repo_url"
            defaultValue={project?.repo_url ?? ""}
            placeholder="https://github.com/you/habit-tracker"
          />
        </Field>
        <Field label="Local folder" htmlFor="local_path" hint="Optional">
          <Input
            id="local_path"
            name="local_path"
            defaultValue={project?.local_path ?? ""}
            placeholder="~/code/habit-tracker"
          />
        </Field>
      </div>

      <Field label="Notes" htmlFor="notes">
        <Textarea id="notes" name="notes" rows={2} defaultValue={project?.notes ?? ""} />
      </Field>

      <fieldset className="grid gap-3 rounded-lg border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1">
            <Label htmlFor="keep_alive">
              {canPing ? "Keep this project alive" : "Watch this project's quota"}
            </Label>
            <p className="text-muted-foreground text-xs">{provider.policy.summary}</p>
          </div>
          <Switch
            id="keep_alive"
            name="keep_alive"
            checked={keepAlive}
            onCheckedChange={setKeepAlive}
          />
        </div>

        {keepAlive && canPing && (
          <div className="grid gap-3 border-t pt-3">
            {provider.projectFields
              .filter((f) => f.tier === "server")
              .map((f) => (
                <Field
                  key={f.key}
                  label={f.label}
                  htmlFor={f.key}
                  hint={
                    <>
                      {f.help}
                      {project?.has_key && f.key === "anon_key" && " Leave blank to keep the saved key."}
                    </>
                  }
                >
                  <Input
                    id={f.key}
                    name={f.key}
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    placeholder={
                      project?.has_key && f.key === "anon_key"
                        ? "•••••••• (saved)"
                        : f.placeholder
                    }
                  />
                </Field>
              ))}

            <div className="grid gap-3 sm:grid-cols-2">
              {providerId === "supabase" && (
                <Field
                  label="Ping table"
                  htmlFor="ping_table"
                  hint="A real DB query; blank falls back to the weaker auth health check"
                >
                  <Input
                    id="ping_table"
                    name="ping_table"
                    defaultValue={
                      (project?.metadata?.ping_table as string | undefined) ??
                      project?.ping_table ??
                      (project ? "" : "keep_alive")
                    }
                    className="font-mono"
                  />
                </Field>
              )}
              <Field
                label="Ping every (days)"
                htmlFor="interval_days"
                hint={
                  provider.policy.pausesAfterDays
                    ? `${provider.name} ${provider.policy.pauseNoun} after ${provider.policy.pausesAfterDays} idle days — ${provider.policy.defaultIntervalDays} leaves margin`
                    : undefined
                }
              >
                <Input
                  id="interval_days"
                  name="interval_days"
                  type="number"
                  min={1}
                  max={60}
                  defaultValue={project?.interval_days ?? provider.policy.defaultIntervalDays}
                />
              </Field>
            </div>

            {providerId === "supabase" && (
              <details className="text-[0.8125rem]">
                <summary className="text-muted-foreground cursor-pointer">
                  SQL to create the keep_alive table in this project
                </summary>
                <pre className="bg-muted mt-2 overflow-x-auto rounded-md p-3 font-mono text-xs">
                  {keepAliveSql}
                </pre>
                <div className="mt-2">
                  <CopyButton text={keepAliveSql} label="Copy SQL" size="sm" variant="outline" />
                </div>
              </details>
            )}
          </div>
        )}
      </fieldset>

      {error && (
        <p role="alert" className="text-destructive text-[0.8125rem]">
          {error}
        </p>
      )}

      <div>
        <SubmitButton pending="Saving…">{project ? "Save changes" : "Add project"}</SubmitButton>
      </div>
    </form>
  );
}
