"use client";

import { useActionState } from "react";
import { PlayIcon, RotateCwIcon } from "lucide-react";
import { restoreProject } from "@/app/providers/actions";
import { SubmitButton } from "@/components/buttons";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Shown when a project is paused or archived.
 *
 * `canRevive` comes from the adapter's capabilities, so a provider that can't be un-paused by
 * API gets a console link instead of a button that would fail.
 */
export function PausedBanner({
  projectId,
  providerName,
  pauseNoun,
  canRevive,
  consoleUrl,
  deletesAfterDays,
  pausedSince,
}: {
  projectId: string;
  providerName: string;
  pauseNoun: string;
  canRevive: boolean;
  consoleUrl: string;
  deletesAfterDays: number | null;
  pausedSince: string | null;
}) {
  const [state, action] = useActionState(restoreProject, null);

  // Only providers that actually delete data get a countdown — Appwrite does, Supabase doesn't.
  let daysLeft: number | null = null;
  if (deletesAfterDays !== null && pausedSince) {
    const elapsed = (Date.now() - new Date(pausedSince).getTime()) / 86_400_000;
    daysLeft = Math.max(0, Math.ceil(deletesAfterDays - elapsed));
  }

  return (
    <Card className="border-destructive/50 bg-destructive/5 mb-4">
      <CardContent className="grid gap-2">
        <h2 className="text-sm font-semibold">
          This project is {pauseNoun} at {providerName}
        </h2>

        {daysLeft !== null ? (
          <p className="text-[0.8125rem]">
            <strong className="font-medium">
              {daysLeft} day{daysLeft === 1 ? "" : "s"} until it is deleted
            </strong>{" "}
            along with all its data. Opening it in the console is what stops the clock.
          </p>
        ) : (
          <p className="text-muted-foreground text-[0.8125rem]">
            Your data is intact. Restoring brings it back; it takes a few minutes.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {canRevive ? (
            <form action={action}>
              <input type="hidden" name="project_id" value={projectId} />
              <SubmitButton size="sm" pending="Requesting…">
                <PlayIcon aria-hidden />
                Restore now
              </SubmitButton>
            </form>
          ) : (
            <SubmitButton size="sm" variant="outline" disabled>
              Restore must be done in the console
            </SubmitButton>
          )}

          <a
            href={consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="text-accent text-xs underline underline-offset-4"
          >
            Open in {providerName}
          </a>
        </div>

        {state?.notice && (
          <p role="status" className="text-accent text-[0.8125rem]">
            <RotateCwIcon className="mr-1 inline size-3.5" aria-hidden />
            {state.notice}
          </p>
        )}
        {state?.error && (
          <p role="alert" className="text-destructive text-[0.8125rem]">
            {state.error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
