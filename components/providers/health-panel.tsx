"use client";

import { useState, useTransition } from "react";
import { ActivityIcon } from "lucide-react";
import { fetchHealth } from "@/app/providers/actions";
import type { HealthReport } from "@/lib/providers/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/** Per-service health, fetched on demand — it's a point-in-time reading, so it isn't stored. */
export function HealthPanel({ projectId }: { projectId: string }) {
  const [reports, setReports] = useState<HealthReport[] | null>(null);
  const [pending, startTransition] = useTransition();

  function check() {
    startTransition(async () => setReports(await fetchHealth(projectId)));
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Service health</h2>
        <Button variant="outline" size="sm" onClick={check} disabled={pending}>
          <ActivityIcon aria-hidden />
          {pending ? "Checking…" : reports ? "Re-check" : "Check"}
        </Button>
      </div>

      {reports === null ? (
        <p className="text-muted-foreground text-xs">
          Reads each service&apos;s status straight from the provider. Needs a personal access
          token on this project&apos;s account.
        </p>
      ) : reports.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No health data. The account needs a personal access token, and the project has to be
          running.
        </p>
      ) : (
        <ul className="grid gap-1.5">
          {reports.map((r) => (
            <li key={r.service} className="flex items-center justify-between gap-2 text-[0.8125rem]">
              <span className="font-mono text-xs">{r.service}</span>
              <Badge
                variant={
                  r.status === "healthy" ? "success" : r.status === "unhealthy" ? "destructive" : "muted"
                }
                title={r.detail ?? undefined}
              >
                {r.status}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
