"use client";

import { useActionState } from "react";
import { PlugZapIcon } from "lucide-react";
import { buildConnectionStrings } from "@/app/providers/actions";
import type { ConnectionStrings as Strings } from "@/lib/providers/types";
import { CopyButton, SubmitButton } from "@/components/buttons";

/**
 * Builds a project's connection strings from its stored database password.
 *
 * Deliberately not stored: the assembled string contains the password in clear, so it is
 * built on demand behind an unlocked vault and never written anywhere.
 *
 * The two names come from the adapter, because not every provider speaks Prisma — Upstash's
 * pair is a REST URL and a `rediss://` URL, and calling those `DATABASE_URL` and `DIRECT_URL`
 * would send someone to paste the wrong one into their app.
 */
const POSTGRES_LABELS: NonNullable<Strings["labels"]> = {
  pooled: { name: "DATABASE_URL", hint: "pooled, for serverless" },
  direct: { name: "DIRECT_URL", hint: "direct, for migrations" },
};

export function ConnectionStrings({
  projectId,
  unlocked,
  hasPassword,
  labels = POSTGRES_LABELS,
}: {
  projectId: string;
  unlocked: boolean;
  hasPassword: boolean;
  labels?: Strings["labels"];
}) {
  const [state, action] = useActionState(buildConnectionStrings, null);
  const names = state?.labels ?? labels ?? POSTGRES_LABELS;

  if (!hasPassword) {
    return (
      <p className="text-muted-foreground text-xs">
        Save this project&apos;s database password under{" "}
        <strong className="font-medium">Credentials</strong> to build{" "}
        <code className="font-mono">{names.pooled.name}</code> and{" "}
        <code className="font-mono">{names.direct.name}</code> here.
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {!state?.pooled && !state?.direct && (
        <form action={action}>
          <input type="hidden" name="project_id" value={projectId} />
          <SubmitButton variant="outline" size="sm" pending="Building…" disabled={!unlocked}>
            <PlugZapIcon aria-hidden />
            Build connection strings
          </SubmitButton>
        </form>
      )}

      {!unlocked && (
        <p className="text-muted-foreground text-xs">
          Unlock your vault — the password is encrypted with your PIN.
        </p>
      )}

      {state?.error && (
        <p role="alert" className="text-destructive text-xs">
          {state.error}
        </p>
      )}

      {(state?.pooled || state?.direct) && (
        <div className="grid gap-2">
          {[
            [names.pooled, state.pooled],
            [names.direct, state.direct],
          ]
            .filter(([, v]) => v)
            .map(([label, value]) => {
              const { name, hint } = label as { name: string; hint: string };
              return (
                <div key={name} className="grid gap-1">
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-semibold">{name}</code>
                    <span className="text-muted-foreground text-xs">{hint}</span>
                    <CopyButton text={value as string} label={`Copy ${name}`} />
                  </div>
                  <code className="bg-muted overflow-x-auto rounded-md px-2 py-1.5 font-mono text-xs">
                    {value as string}
                  </code>
                </div>
              );
            })}
          <p className="text-muted-foreground text-xs">
            These contain your password in clear. They aren&apos;t stored anywhere — copy what
            you need and close the page.
          </p>
        </div>
      )}

      {state?.pooled === null && state?.direct && !state.error && (
        <p className="text-muted-foreground text-xs">
          Only the direct URL is shown: the pooler host for this project isn&apos;t known yet.
          Run a sync to pick it up, or copy the pooled string from the provider&apos;s dashboard.
        </p>
      )}
    </div>
  );
}
