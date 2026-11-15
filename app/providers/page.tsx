import Link from "next/link";
import { CheckIcon, ExternalLinkIcon, MinusIcon, PlusIcon } from "lucide-react";
import { listAccounts, listProjects } from "@/lib/registry";
import { activeProviders, isImplemented } from "@/lib/providers/registry";
import { PROVIDER_IDS, type Capabilities, type Lifecycle, type Policy } from "@/lib/providers/types";
import {
  LifecycleBadge,
  ProviderBadge,
  StrategyBadge,
} from "@/components/providers/provider-badge";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Capability copy lives here, not in the adapters: the adapter declares *whether* it can do a
 * thing, and this page is the only place that decides how to say it. Keyed by `Capabilities`
 * so adding a capability to the type is a compile error until it gets a label.
 */
const CAPABILITY_COPY: Record<keyof Capabilities, { label: string; yes: string; no: string }> = {
  discover: {
    label: "Discover",
    yes: "Keepstack can list this account's projects from an API token.",
    no: "No account-level listing API — projects are added by hand.",
  },
  ping: {
    label: "Keep-alive",
    yes: "Keepstack can run a real query that resets the inactivity clock.",
    no: "No action here would reset an inactivity clock, so Keepstack doesn't pretend to.",
  },
  watch: {
    label: "Usage",
    yes: "Reports quota metrics, so Keepstack can chart the budget that actually matters.",
    no: "No usage metrics worth charting.",
  },
  revive: {
    label: "Resume",
    yes: "Keepstack can un-pause a project without opening the provider's console.",
    no: "Resuming needs the provider's own console — there is no API path back.",
  },
  health: {
    label: "Health",
    yes: "Reports per-service status, not just up or down.",
    no: "No richer health signal than a successful query.",
  },
  rotate: {
    label: "Rotate",
    yes: "Supports rotating a database or role password.",
    no: "No password rotation API wired up.",
  },
};

/** The lifecycle values worth surfacing as a footprint breakdown, in order of urgency. */
const LIFECYCLE_ORDER: Lifecycle[] = ["active", "paused", "archived", "idle", "unknown", "deleted"];

function PolicyFacts({ policy, canPing }: { policy: Policy; canPing: boolean }) {
  const facts: { term: string; detail: string }[] = [
    {
      term: "Inactivity",
      detail:
        policy.pausesAfterDays === null
          ? "Never pauses for being idle"
          : `${policy.pausesAfterDays} days idle → ${policy.pauseNoun}`,
    },
    {
      term: "Data",
      detail:
        policy.deletesAfterDays === null
          ? `Kept indefinitely once ${policy.pauseNoun}`
          : `Deleted ${policy.deletesAfterDays} days after being ${policy.pauseNoun}`,
    },
  ];

  // An interval is only a real setting where a ping does something. Showing "every 1d" for a
  // watch-only provider would read as a keep-alive schedule that isn't running.
  if (canPing) {
    facts.push({ term: "Default interval", detail: `Every ${policy.defaultIntervalDays} days` });
  }

  return (
    <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-3">
      {facts.map((f) => (
        <div key={f.term} className="grid gap-0.5">
          <dt className="text-muted-foreground text-xs">{f.term}</dt>
          <dd className="text-[0.8125rem]">{f.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

function CapabilityGrid({ capabilities }: { capabilities: Capabilities }) {
  const keys = Object.keys(CAPABILITY_COPY) as (keyof Capabilities)[];
  return (
    <ul className="flex flex-wrap gap-1.5">
      {keys.map((key) => {
        const on = capabilities[key];
        const copy = CAPABILITY_COPY[key];
        return (
          <li key={key}>
            {/* Icon plus label, never colour alone — this stays readable in greyscale. */}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
                on
                  ? "border-success/25 bg-success/12 text-success"
                  : "border-transparent bg-muted text-muted-foreground",
              )}
              title={on ? copy.yes : copy.no}
            >
              {on ? (
                <CheckIcon className="size-3 shrink-0" aria-hidden />
              ) : (
                <MinusIcon className="size-3 shrink-0" aria-hidden />
              )}
              {copy.label}
              <span className="sr-only">: {on ? copy.yes : copy.no}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default async function ProvidersPage() {
  const [accounts, projects] = await Promise.all([listAccounts(), listProjects()]);
  const adapters = activeProviders();
  const pending = PROVIDER_IDS.filter((id) => !isImplemented(id));

  return (
    <>
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Providers</h1>
        <p className="text-muted-foreground text-[0.8125rem]">
          What Keepstack knows how to do at each database provider, and what you have there.
          Every rule below is read from the provider&apos;s adapter, so this page and the
          scheduler can never disagree.
        </p>
      </div>

      <div className="grid gap-3">
        {adapters.map((adapter) => {
          const mine = projects.filter((p) => p.provider === adapter.id);
          const myAccounts = accounts.filter((a) => a.provider === adapter.id);
          const counts = LIFECYCLE_ORDER.map((lc) => ({
            lifecycle: lc,
            n: mine.filter((p) => p.lifecycle === lc).length,
          })).filter((c) => c.n > 0);

          return (
            <Card key={adapter.id}>
              <CardContent className="grid gap-3">
                {/* -------- Header -------- */}
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ProviderBadge provider={adapter.id} />
                    <StrategyBadge policy={adapter.policy} />
                  </div>
                  <Button asChild variant="ghost" size="sm">
                    <a href={adapter.policy.docsUrl} target="_blank" rel="noreferrer noopener">
                      Provider docs
                      <ExternalLinkIcon aria-hidden />
                    </a>
                  </Button>
                </div>

                {/* -------- The honest summary, verbatim from the adapter -------- */}
                <p className="text-muted-foreground text-[0.8125rem]">{adapter.policy.summary}</p>

                <PolicyFacts policy={adapter.policy} canPing={adapter.capabilities.ping} />

                <div className="grid gap-1.5">
                  <p className="text-muted-foreground text-xs">Keepstack can</p>
                  <CapabilityGrid capabilities={adapter.capabilities} />
                </div>

                {/* -------- Your footprint -------- */}
                <div className="border-t pt-3">
                  {mine.length === 0 && myAccounts.length === 0 ? (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-muted-foreground text-[0.8125rem]">
                        Nothing here yet.
                      </p>
                      <Button asChild variant="outline" size="sm">
                        <Link href="/accounts">
                          <PlusIcon aria-hidden />
                          Add {adapter.name} account
                        </Link>
                      </Button>
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[0.8125rem]">
                          <strong>{mine.length}</strong>{" "}
                          {mine.length === 1 ? "project" : "projects"} across{" "}
                          <strong>{myAccounts.length}</strong>{" "}
                          {myAccounts.length === 1 ? "account" : "accounts"}
                        </span>
                        {counts.map((c) => (
                          <span key={c.lifecycle} className="flex items-center gap-1">
                            <LifecycleBadge lifecycle={c.lifecycle} policy={adapter.policy} />
                            <span className="text-muted-foreground text-xs">{c.n}</span>
                          </span>
                        ))}
                      </div>

                      {mine.length > 0 && (
                        <ul className="grid gap-0.5 text-[0.8125rem] sm:grid-cols-2">
                          {mine.map((p) => (
                            <li key={p.id} className="flex items-center gap-2">
                              <Link
                                href={`/projects/${p.id}`}
                                className="truncate underline-offset-4 hover:underline"
                              >
                                {p.name}
                              </Link>
                              {p.account && (
                                <span className="text-muted-foreground truncate text-xs">
                                  {p.account.label ?? p.account.email}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* -------- Declared but not implemented -------- */}
      {pending.length > 0 && (
        <Card className="mt-3">
          <CardContent className="grid gap-2">
            <h2 className="text-sm font-semibold">Not implemented yet</h2>
            <p className="text-muted-foreground text-[0.8125rem]">
              These are in the provider enum — a project row could name one — but no adapter is
              registered, so Keepstack cannot sync, ping or watch them.
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {pending.map((id) => (
                <span key={id} className="flex items-center gap-1.5">
                  <ProviderBadge provider={id} />
                  <Badge variant="muted">No adapter</Badge>
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
