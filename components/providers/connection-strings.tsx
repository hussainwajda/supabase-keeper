"use client";

import { useActionState } from "react";
import { PlugZapIcon } from "lucide-react";
import { buildConnectionStrings } from "@/app/providers/actions";
import { CopyButton, SubmitButton } from "@/components/buttons";

/**
 * Builds the Prisma/Drizzle pair from the stored database password.
 *
 * Deliberately not stored: the assembled string contains the password in clear, so it is
 * built on demand behind an unlocked vault and never written anywhere.
 */
export function ConnectionStrings({
  projectId,
  unlocked,
  hasPassword,
}: {
  projectId: string;
  unlocked: boolean;
  hasPassword: boolean;
}) {
  const [state, action] = useActionState(buildConnectionStrings, null);

  if (!hasPassword) {
    return (
      <p className="text-muted-foreground text-xs">
        Save this project&apos;s database password under <strong className="font-medium">Credentials</strong>{" "}
        to build <code className="font-mono">DATABASE_URL</code> and{" "}
        <code className="font-mono">DIRECT_URL</code> here.
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
            ["DATABASE_URL", state.pooled, "pooled, for serverless"],
            ["DIRECT_URL", state.direct, "direct, for migrations"],
          ]
            .filter(([, v]) => v)
            .map(([label, value, hint]) => (
              <div key={label as string} className="grid gap-1">
                <div className="flex items-center gap-2">
                  <code className="text-xs font-semibold">{label}</code>
                  <span className="text-muted-foreground text-xs">{hint}</span>
                  <CopyButton text={value as string} label={`Copy ${label}`} />
                </div>
                <code className="bg-muted overflow-x-auto rounded-md px-2 py-1.5 font-mono text-xs">
                  {value}
                </code>
              </div>
            ))}
          <p className="text-muted-foreground text-xs">
            These contain your password in clear. They aren&apos;t stored anywhere — copy what
            you need and close the page.
          </p>
        </div>
      )}

      {state?.pooled === null && state?.direct && !state.error && (
        <p className="text-muted-foreground text-xs">
          Only the direct URL is shown: the pooler host for this project isn&apos;t known yet.
          Run a sync to pick it up, or copy the pooled string from the Supabase dashboard.
        </p>
      )}
    </div>
  );
}
