import Link from "next/link";
import { DownloadIcon } from "lucide-react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listAccounts, listProjects, schemaStatus, slotsUsed, toSafeProject } from "@/lib/registry";
import { claimAvailable } from "@/lib/registry/claim";
import { currentUser } from "@/lib/supabase/server";
import { activeProviders, getProvider } from "@/lib/providers/registry";
import type { Policy, ProviderId } from "@/lib/providers/types";
import { ProjectBoard, type BoardProject, type PolicyMap } from "@/components/project-board";
import { SubmitButton } from "@/components/buttons";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { pingAll, parsePastedIdentifier } from "@/app/actions";
import { daysUntilPauseRisk, isUrgentRisk } from "@/lib/format";
import { MigrationNotice } from "@/components/migration-notice";
import { ClaimNotice } from "@/components/claim-notice";
import { EncryptKeysNotice } from "@/components/vault/encrypt-keys-notice";
import { keyMigrationStatus } from "@/lib/vault/migrate-keys";
import { projectIdsWithStoredKey, vaultSchemaReady } from "@/lib/vault/secrets";
import { vaultConfigured } from "@/lib/crypto/env";
import { vaultStatus } from "@/lib/vault";

export const dynamic = "force-dynamic";

function Stat({
  value,
  label,
  tone,
}: {
  value: React.ReactNode;
  label: React.ReactNode;
  tone?: "warn" | "err";
}) {
  return (
    <Card className="gap-1 py-3">
      <CardContent className="grid gap-0.5">
        <div
          className={`text-2xl leading-none font-semibold tabular ${
            tone === "err" ? "text-destructive" : tone === "warn" ? "text-warning" : ""
          }`}
        >
          {value}
        </div>
        <div className="text-muted-foreground text-xs">{label}</div>
      </CardContent>
    </Card>
  );
}

export default async function Dashboard() {
  const user = await currentUser();
  const [projects, accounts, schema, claim, keyMigration] = await Promise.all([
    listProjects(),
    listAccounts(),
    schemaStatus(),
    claimAvailable(user?.email ?? null),
    vaultConfigured() && (await vaultSchemaReady())
      ? keyMigrationStatus()
      : Promise.resolve({ pending: 0, columnDropped: false }),
  ]);

  // A project counts as having a key if it's in the vault OR still in the legacy column.
  const vaultReady = vaultConfigured() && (await vaultSchemaReady());
  const vaultKeyIds =
    vaultReady && user ? await projectIdsWithStoredKey(user.id) : new Set<string>();
  const pinReady = vaultReady && user ? (await vaultStatus(user.id)).initialized : false;

  const migrationSql = schema.migration0002
    ? null
    : await readFile(
        path.join(process.cwd(), "supabase/migrations/0002_multi_provider.sql"),
        "utf8",
      ).catch(() => "See supabase/migrations/0002_multi_provider.sql in the repo.");

  // Policies are serialised for the client; adapters themselves stay on the server.
  const policies: PolicyMap = {};
  for (const adapter of activeProviders()) policies[adapter.id] = adapter.policy;

  // Secret columns are stripped before anything crosses into a client component.
  const board: BoardProject[] = projects.map((p) => {
    const { account, ...rest } = p;
    const safe = toSafeProject(rest as typeof rest & { anon_key: string | null });
    return {
      ...safe,
      has_key: safe.has_key || vaultKeyIds.has(p.id),
      account,
      console_url: getProvider(p.provider).consoleUrl({
        externalId: p.external_id,
        name: p.name,
        metadata: p.metadata,
      }),
    } as BoardProject;
  });

  const used = slotsUsed(projects);
  // Counted apart because they are different claims: one resets an inactivity clock, the
  // other only watches a quota.
  const keepAlive = projects.filter(
    (p) => p.keep_alive && policies[p.provider as ProviderId]?.strategy === "ping",
  ).length;
  const watched = projects.filter(
    (p) => p.keep_alive && policies[p.provider as ProviderId]?.strategy !== "ping",
  ).length;
  const failing = projects.filter((p) => p.keep_alive && p.last_status === "error").length;
  const paused = projects.filter((p) => p.lifecycle === "paused" || p.lifecycle === "archived").length;

  const atRisk = projects.filter((p) => {
    if (!p.keep_alive) return false;
    const policy: Policy | undefined = policies[p.provider as ProviderId];
    if (!policy) return false;
    return isUrgentRisk(daysUntilPauseRisk(p.last_pinged_at, policy), policy);
  }).length;

  // Free slots are still Supabase's 2-per-account rule. Phase 3 reads real org limits from
  // the Management API, and other providers have their own counts.
  const freeAccounts = accounts.filter((a) => a.provider === "supabase" && (used[a.id] ?? 0) < 2);
  const freeSlots = freeAccounts.reduce((n, a) => n + 2 - (used[a.id] ?? 0), 0);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
          <p className="text-muted-foreground text-[0.8125rem]">
            Every database you own, across every account. Paste anything to find its owner.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <a href="/api/export" download>
              <DownloadIcon aria-hidden />
              Export JSON
            </a>
          </Button>
          <form action={pingAll}>
            <SubmitButton variant="outline" size="sm" pending="Pinging…">
              Ping all now
            </SubmitButton>
          </form>
        </div>
      </div>

      {migrationSql && <MigrationNotice sql={migrationSql} />}
      {claim.allowed && <ClaimNotice orphans={claim.orphans} />}
      {keyMigration.pending > 0 && (
        <EncryptKeysNotice pending={keyMigration.pending} pinReady={pinReady} />
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat value={accounts.length} label="Accounts" />
        <Stat value={projects.length} label="Projects" />
        <Stat value={keepAlive} label="Kept alive" />
        {watched > 0 && <Stat value={watched} label="Watched" />}
        <Stat value={paused} label="Paused" tone={paused ? "err" : undefined} />
        <Stat value={failing} label="Failing pings" tone={failing ? "err" : undefined} />
        <Stat
          value={atRisk}
          label="At risk soon"
          tone={atRisk ? "warn" : undefined}
        />
      </div>

      {accounts.length === 0 && !claim.allowed ? (
        <Card>
          <CardContent className="grid gap-2">
            <h2 className="text-base font-semibold">Start by adding an account</h2>
            <p className="text-muted-foreground text-[0.8125rem]">
              Add each email you use to log into a database provider, then add the projects under
              it.
            </p>
            <div>
              <Button asChild size="sm">
                <Link href="/accounts">Add an account</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {freeAccounts[0] && (
            <p className="text-muted-foreground mb-3 text-xs">
              {freeSlots} free Supabase {freeSlots === 1 ? "slot" : "slots"} left · next:{" "}
              <Link href="/accounts" className="text-accent underline-offset-4 hover:underline">
                {freeAccounts[0].label ?? freeAccounts[0].email}
              </Link>
            </p>
          )}
          <ProjectBoard projects={board} policies={policies} parseAction={parsePastedIdentifier} />
        </>
      )}
    </>
  );
}
