import { AlertTriangleIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { CopyButton } from "@/components/buttons";

/**
 * Shown until migration 0002 has been applied to the registry database. Reads already
 * degrade to the pre-0002 shape, but writes need the new columns — so this says exactly
 * what to run rather than letting a save fail with a Postgres error.
 */
export function MigrationNotice({ sql }: { sql: string }) {
  return (
    <Card className="border-warning/50 bg-warning/5 mb-5">
      <CardContent className="grid gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <AlertTriangleIcon className="text-warning size-4" aria-hidden />
          One migration pending
        </h2>
        <p className="text-muted-foreground text-[0.8125rem]">
          Your registry is still on the pre-Keepstack schema. Everything below is read from it
          safely, but <strong className="text-foreground font-medium">saving is disabled</strong>{" "}
          until you run <code className="font-mono">supabase/migrations/0002_multi_provider.sql</code>{" "}
          in the SQL editor of your registry project. It is additive — nothing is dropped.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton text={sql} label="Copy migration SQL" size="sm" variant="outline" />
          <span className="text-muted-foreground text-xs">
            Export your registry first with the button above.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
