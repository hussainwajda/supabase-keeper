"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowUpRightIcon, SearchIcon, XIcon } from "lucide-react";
import type { SafeProjectWithAccount } from "@/lib/registry/types";
import type { Policy, ProviderId } from "@/lib/providers/types";
import { daysUntilPauseRisk, isUrgentRisk, nextPingLabel, timeAgo } from "@/lib/format";
import { pingNow } from "@/app/actions";
import { CopyButton, SubmitButton } from "@/components/buttons";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LifecycleBadge, ProviderBadge } from "@/components/providers/provider-badge";

export type BoardProject = SafeProjectWithAccount & { console_url: string };

/** Serialisable policy map, passed from the server so the client needn't import adapters. */
export type PolicyMap = Partial<Record<ProviderId, Policy>>;

type Match = { provider: ProviderId; externalId: string; hint?: string };

export function ProjectBoard({
  projects,
  policies,
  parseAction,
}: {
  projects: BoardProject[];
  policies: PolicyMap;
  /** Server-side paste parsing, so every adapter's `parse()` stays on the server. */
  parseAction: (input: string) => Promise<Match | null>;
}) {
  const [q, setQ] = useState("");
  const [match, setMatch] = useState<Match | null>(null);

  async function onQueryChange(value: string) {
    setQ(value);
    setMatch(value.trim() ? await parseAction(value) : null);
  }

  const exact = match ? projects.find((p) => p.provider === match.provider && p.external_id === match.externalId) : undefined;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return projects;
    if (exact) return [exact];
    return projects.filter((p) =>
      [p.name, p.external_id, p.repo_url, p.local_path, p.notes, p.account?.email, p.account?.label]
        .some((f) => f?.toLowerCase().includes(needle)),
    );
  }, [projects, q, exact]);

  return (
    <div className="grid gap-4">
      <div className="relative">
        <SearchIcon
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          value={q}
          onChange={(e) => void onQueryChange(e.target.value)}
          onPaste={(e) => {
            // Pasting a multi-line .env into a single-line input: keep only what we need.
            const text = e.clipboardData.getData("text");
            if (text.includes("\n")) {
              e.preventDefault();
              void onQueryChange(text.replace(/\s+/g, " ").slice(0, 400));
            }
          }}
          placeholder="Search by name, repo, account… or paste a project URL, connection string, or a whole .env"
          aria-label="Search projects"
          className="h-10 pr-10 pl-9"
        />
        {q && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear search"
            onClick={() => void onQueryChange("")}
            className="absolute top-1/2 right-1.5 -translate-y-1/2"
          >
            <XIcon aria-hidden />
          </Button>
        )}
      </div>

      {exact && (
        <Card className="border-accent/40 bg-accent/5">
          <CardContent className="grid gap-2">
            <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
              <ProviderBadge provider={exact.provider} />
              <code className="font-mono">{exact.external_id}</code>
              {match?.hint && <span>found in {match.hint}</span>}
              <span>belongs to</span>
            </div>

            {exact.account ? (
              <>
                <div className="flex items-center gap-1 text-base font-semibold">
                  {exact.account.email}
                  <CopyButton text={exact.account.email} label="Copy email" />
                </div>
                <div className="text-muted-foreground text-[0.8125rem]">
                  {exact.account.label && <>{exact.account.label} · </>}
                  Log in with{" "}
                  <strong className="text-foreground font-medium">
                    {exact.account.login_method ?? "not recorded"}
                  </strong>
                </div>
              </>
            ) : (
              <div className="text-warning font-medium">No account assigned yet</div>
            )}

            <div className="mt-1 flex flex-wrap items-center gap-2">
              <strong>{exact.name}</strong>
              <Button asChild size="sm">
                <a href={exact.console_url} target="_blank" rel="noreferrer">
                  Open dashboard
                  <ArrowUpRightIcon aria-hidden />
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={`/projects/${exact.id}`}>Details</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {match && !exact && (
        <Card className="border-warning/50 bg-warning/5">
          <CardContent className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2 font-medium">
              <ProviderBadge provider={match.provider} />
              <code className="font-mono">{match.externalId}</code>
              <span>isn&apos;t in your registry yet.</span>
            </div>
            <p className="text-muted-foreground text-[0.8125rem]">
              Log into each account until you find it, then save it here so you never have to
              search again.
            </p>
            <div>
              <Button asChild size="sm">
                <Link href={`/projects/new?provider=${match.provider}&ref=${match.externalId}`}>
                  Add this project
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Keep-alive</TableHead>
              <TableHead className="hidden md:table-cell">Last ping</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                  {projects.length ? (
                    "No matches."
                  ) : (
                    <>
                      No projects yet.{" "}
                      <Link href="/projects/new" className="text-accent underline-offset-4 hover:underline">
                        Add one
                      </Link>
                      .
                    </>
                  )}
                </TableCell>
              </TableRow>
            )}

            {filtered.map((p) => {
              const policy = policies[p.provider];
              const risk = policy ? daysUntilPauseRisk(p.last_pinged_at, policy) : null;
              const urgent = policy ? isUrgentRisk(risk, policy) : false;

              return (
                <TableRow key={p.id}>
                  <TableCell>
                    <Link
                      href={`/projects/${p.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {p.name}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <ProviderBadge provider={p.provider} />
                      <code className="text-muted-foreground font-mono text-xs">{p.external_id}</code>
                    </div>
                    {p.repo_url && (
                      <div className="text-muted-foreground mt-0.5 text-xs">
                        {p.repo_url.replace(/^https?:\/\//, "")}
                      </div>
                    )}
                  </TableCell>

                  <TableCell>
                    {p.account ? (
                      <>
                        <div className="text-[0.8125rem]">{p.account.email}</div>
                        {p.account.login_method && (
                          <Badge variant="muted" className="mt-0.5">
                            {p.account.login_method}
                          </Badge>
                        )}
                      </>
                    ) : (
                      <span className="text-warning text-[0.8125rem]">Unassigned</span>
                    )}
                  </TableCell>

                  <TableCell>
                    <LifecycleBadge lifecycle={p.lifecycle} policy={policy} />
                  </TableCell>

                  <TableCell>
                    {!p.keep_alive ? (
                      <span className="text-muted-foreground text-[0.8125rem]">off</span>
                    ) : policy?.strategy === "watch" ? (
                      // No interval: this provider doesn't pause, and pinging it would spend
                      // the quota the watching protects.
                      <>
                        <div className="text-[0.8125rem]">quota watch</div>
                        <div className="text-muted-foreground text-xs">daily usage read</div>
                      </>
                    ) : policy?.strategy === "alert_only" ? (
                      <>
                        <div className="text-[0.8125rem]">alerts only</div>
                        <div className="text-muted-foreground text-xs">status check, no ping</div>
                      </>
                    ) : (
                      <>
                        <div className="text-[0.8125rem]">every {p.interval_days}d</div>
                        <div className="text-muted-foreground text-xs" suppressHydrationWarning>
                          next: {nextPingLabel(p.last_pinged_at, p.interval_days, true)}
                        </div>
                        {!p.has_key && (
                          <div className="text-destructive text-xs">missing credentials</div>
                        )}
                      </>
                    )}
                  </TableCell>

                  <TableCell className="hidden md:table-cell">
                    <span className="text-[0.8125rem]" suppressHydrationWarning>
                      {timeAgo(p.last_pinged_at)}
                    </span>
                    {p.last_status === "error" && (
                      <div className="text-destructive text-xs" title={p.last_error ?? ""}>
                        {(p.last_error ?? "error").slice(0, 60)}
                      </div>
                    )}
                    {p.keep_alive && policy?.strategy !== "watch" && urgent && risk !== null && (
                      <div className="text-warning text-xs" suppressHydrationWarning>
                        {policy?.pauseNoun ?? "pause"} risk in {Math.max(0, risk).toFixed(1)}d
                      </div>
                    )}
                  </TableCell>

                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {policy?.strategy === "ping" && (
                        <form action={pingNow}>
                          <input type="hidden" name="id" value={p.id} />
                          <SubmitButton variant="outline" size="sm" pending="…">
                            Ping
                          </SubmitButton>
                        </form>
                      )}
                      <Button asChild variant="ghost" size="icon-sm">
                        <a
                          href={p.console_url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open ${p.name} in its provider console`}
                        >
                          <ArrowUpRightIcon aria-hidden />
                        </a>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
