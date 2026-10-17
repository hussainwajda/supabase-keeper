"use client";

import { useActionState } from "react";
import { DownloadCloudIcon, RefreshCwIcon } from "lucide-react";
import { confirmSync, previewSync } from "@/app/providers/actions";
import type { ProviderId } from "@/lib/providers/types";
import { SubmitButton } from "@/components/buttons";
import { Badge } from "@/components/ui/badge";

/**
 * Discovery for one account: preview, then apply.
 *
 * Two steps on purpose. A sync can import a dozen projects and re-home others, and seeing
 * exactly what will change beats finding out afterwards.
 */
export function SyncPanel({
  accountId,
  provider,
  providerName,
  lastSyncedAt,
  lastStatus,
  lastError,
  hasToken,
  tokenFieldLabel,
}: {
  accountId: string;
  provider: ProviderId;
  providerName: string;
  lastSyncedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  hasToken: boolean;
  tokenFieldLabel: string;
}) {
  const [preview, previewAction] = useActionState(previewSync, null);
  const [applied, applyAction] = useActionState(confirmSync, null);

  if (!hasToken) {
    return (
      <p className="text-muted-foreground text-xs">
        Add a {tokenFieldLabel.toLowerCase()} under <strong className="font-medium">Credentials</strong>{" "}
        above to import this account&apos;s projects automatically.
      </p>
    );
  }

  const plan = preview?.plan;
  const nothingToDo =
    plan &&
    plan.toCreate.length === 0 &&
    plan.toUpdate.length === 0 &&
    plan.reassigned.length === 0 &&
    plan.missing.length === 0;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <form action={previewAction}>
          <input type="hidden" name="account_id" value={accountId} />
          <input type="hidden" name="provider" value={provider} />
          <SubmitButton variant="outline" size="sm" pending="Checking…">
            <RefreshCwIcon aria-hidden />
            Check for projects
          </SubmitButton>
        </form>

        {lastSyncedAt && (
          <span className="text-muted-foreground text-xs">
            last synced {new Date(lastSyncedAt).toLocaleString()}
          </span>
        )}
        {lastStatus === "error" && <Badge variant="destructive">Last sync failed</Badge>}
      </div>

      {lastStatus === "error" && lastError && !preview && (
        <p className="text-destructive text-xs">{lastError}</p>
      )}

      {preview?.error && (
        <p role="alert" className="text-destructive text-[0.8125rem]">
          {preview.error}
        </p>
      )}

      {applied?.applied && (
        <p role="status" className="text-accent text-[0.8125rem]">
          {applied.applied}
        </p>
      )}
      {applied?.error && (
        <p role="alert" className="text-destructive text-[0.8125rem]">
          {applied.error}
        </p>
      )}

      {plan && (
        <div className="bg-muted/50 grid gap-3 rounded-md border p-3">
          {nothingToDo ? (
            <p className="text-[0.8125rem]">
              Everything matches — {plan.unchanged} project
              {plan.unchanged === 1 ? "" : "s"} already in step.
            </p>
          ) : (
            <>
              {plan.toCreate.length > 0 && (
                <div className="grid gap-1">
                  <p className="text-[0.8125rem] font-medium">
                    {plan.toCreate.length} new project{plan.toCreate.length === 1 ? "" : "s"} to
                    import
                  </p>
                  <ul className="grid gap-0.5">
                    {plan.toCreate.map((p) => (
                      <li key={p.externalId} className="text-muted-foreground text-xs">
                        {p.name} <code className="font-mono">{p.externalId}</code>
                        {p.lifecycle === "paused" && (
                          <Badge variant="destructive" className="ml-1.5">
                            paused
                          </Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {plan.toUpdate.length > 0 && (
                <div className="grid gap-1">
                  <p className="text-[0.8125rem] font-medium">
                    {plan.toUpdate.length} status change{plan.toUpdate.length === 1 ? "" : "s"}
                  </p>
                  <ul className="grid gap-0.5">
                    {plan.toUpdate.map((u) => (
                      <li key={u.id} className="text-muted-foreground text-xs">
                        {u.name}:{" "}
                        {Object.entries(u.changes)
                          .map(([f, c]) => `${f} ${String(c.from ?? "—")} → ${String(c.to)}`)
                          .join(", ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {plan.reassigned.length > 0 && (
                <div className="grid gap-1">
                  <p className="text-[0.8125rem] font-medium">
                    {plan.reassigned.length} registered under a different account
                  </p>
                  <ul className="grid gap-0.5">
                    {plan.reassigned.map((r) => (
                      <li key={r.id} className="text-muted-foreground text-xs">
                        {r.name} <code className="font-mono">{r.externalId}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground text-xs">
                    Tick &ldquo;move&rdquo; below to re-home them to this account.
                  </p>
                </div>
              )}

              {plan.missing.length > 0 && (
                <div className="grid gap-1">
                  <p className="text-warning text-[0.8125rem] font-medium">
                    {plan.missing.length} in Keepstack but not visible to this token
                  </p>
                  <ul className="grid gap-0.5">
                    {plan.missing.map((m) => (
                      <li key={m.id} className="text-muted-foreground text-xs">
                        {m.name} <code className="font-mono">{m.externalId}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground text-xs">
                    Left alone. A deleted project and a token that lost access to an
                    organization look the same from here, and only one of those is safe to act
                    on — remove them by hand if they really are gone.
                  </p>
                </div>
              )}
            </>
          )}

          {!nothingToDo && (
            <form action={applyAction} className="grid gap-2 border-t pt-3">
              <input type="hidden" name="account_id" value={accountId} />
              <input type="hidden" name="provider" value={provider} />

              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" name="fetch_keys" defaultChecked className="cursor-pointer" />
                Fetch each project&apos;s anon key automatically, encrypted
              </label>

              {plan.reassigned.length > 0 && (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" name="adopt" className="cursor-pointer" />
                  Move the {plan.reassigned.length} project
                  {plan.reassigned.length === 1 ? "" : "s"} above to this account
                </label>
              )}

              <p className="text-muted-foreground text-xs">
                Imported projects start with keep-alive <strong className="font-medium">off</strong>
                , so nothing starts pinging {providerName} without you asking.
              </p>

              <div>
                <SubmitButton size="sm" pending="Applying…">
                  <DownloadCloudIcon aria-hidden />
                  Apply
                </SubmitButton>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
