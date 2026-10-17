import { ArchiveRestoreIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/buttons";
import { claimLegacy } from "@/app/actions";
import type { OrphanCount } from "@/lib/registry/claim";

/**
 * Shown once, after migration 0003, when rows exist that predate sign-in.
 *
 * RLS hides unowned rows, so without this the dashboard would simply look empty and the
 * user would reasonably think their data was gone. It isn't — it just has no owner yet.
 */
export function ClaimNotice({ orphans }: { orphans: OrphanCount }) {
  const parts = [
    orphans.accounts > 0 && `${orphans.accounts} account${orphans.accounts === 1 ? "" : "s"}`,
    orphans.projects > 0 && `${orphans.projects} project${orphans.projects === 1 ? "" : "s"}`,
  ].filter(Boolean);

  return (
    <Card className="border-accent/50 bg-accent/5 mb-5">
      <CardContent className="grid gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ArchiveRestoreIcon className="text-accent size-4" aria-hidden />
          {parts.join(" and ")} waiting to be claimed
        </h2>
        <p className="text-muted-foreground text-[0.8125rem]">
          These rows were created before Keepstack had sign-in, so they have no owner yet — and
          row level security hides unowned rows, which is why the dashboard looks empty.{" "}
          <strong className="text-foreground font-medium">Nothing has been deleted.</strong> Claim
          them to assign them to the account you&apos;re signed in as.
        </p>
        <form action={claimLegacy}>
          <SubmitButton size="sm" pending="Claiming…">
            Claim these rows
          </SubmitButton>
        </form>
        <p className="text-muted-foreground text-xs">
          Afterwards: run <code className="font-mono">0004_require_owner.sql</code> and remove{" "}
          <code className="font-mono">KEEPSTACK_ALLOW_LEGACY_CLAIM</code> from your environment.
        </p>
      </CardContent>
    </Card>
  );
}
