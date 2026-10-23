import { notFound } from "next/navigation";
import { ArrowUpRightIcon } from "lucide-react";
import { getProject, listAccounts, listProjects, recentLogs, slotsUsed, toSafeProject } from "@/lib/registry";
import { getProvider } from "@/lib/providers/registry";
import { providerOptions } from "@/lib/providers/options";
import { ProjectForm } from "@/components/project-form";
import { SubmitButton } from "@/components/buttons";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LifecycleBadge, ProviderBadge, StrategyBadge } from "@/components/providers/provider-badge";
import { KEEP_ALIVE_SQL } from "@/lib/keep-alive-sql";
import { currentUser } from "@/lib/backend/user";
import { vaultStatus, vaultUnlocked } from "@/lib/vault";
import { listSecrets, vaultReady } from "@/lib/vault/secrets";
import { otpAvailable } from "@/lib/vault/email";
import { serverCredentialKinds } from "@/lib/vault/kinds";
import { SecretSlots, type SecretSlot } from "@/components/vault/secret-form";
import { UnlockDialog } from "@/components/vault/unlock-dialog";
import { PausedBanner } from "@/components/providers/paused-banner";
import { HealthPanel } from "@/components/providers/health-panel";
import { ConnectionStrings } from "@/components/providers/connection-strings";
import { refreshStatus, refreshUsage } from "@/app/providers/actions";
import { UsageMeters } from "@/components/providers/usage-meters";
import { PlanLimits, hasPlanLimits } from "@/components/providers/plan-limits";
import { ProviderSetup, hasProviderSetup } from "@/components/providers/provider-setup";
import { latestUsage, usageHistory } from "@/lib/usage";
import { deleteProject, pingNow } from "@/app/actions";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  const [project, accounts, projects, logs] = await Promise.all([
    getProject(id),
    listAccounts(),
    listProjects(),
    recentLogs(id),
  ]);
  if (!project) notFound();


  const adapter = getProvider(project.provider);
  // Credentials panel. Each adapter declares the fields it needs and which tier they belong
  // in, so this stays correct for every provider without a per-provider branch here.
  // The gate stays: on the Supabase backend `vaultReady` also checks the vault schema exists,
  // and the calls below assume it does. The duplicate round trip it used to cost is gone —
  // `vaultReady` and `vaultStatus` hit the same endpoint, which is now deduped per request.
  const ready = await vaultReady();
  const [status, unlocked, secrets] =
    ready && user
      ? await Promise.all([
          vaultStatus(user.id),
          vaultUnlocked(user.id),
          listSecrets({ projectId: id }),
        ])
      : [null, false, []];

  const storedByKind = new Map(secrets.map((s) => [s.kind, s.id]));

  // Quota meters for `watch` providers. Nothing is fetched for a `ping` provider — Supabase
  // publishes no per-project usage, and an empty card would imply it does.
  const usage = adapter.capabilities.watch ? await latestUsage(id) : [];
  // One request per metric, in parallel. These were awaited in a loop, so a project with four
  // quota meters paid four round trips end to end before the page could render at all.
  const usageTrends: Record<string, Awaited<ReturnType<typeof usageHistory>>> = Object.fromEntries(
    await Promise.all(
      usage.map(async (row) => [row.metric, await usageHistory(id, row.metric)] as const),
    ),
  );
  const secretSlots: SecretSlot[] = adapter.projectFields.map((f) => ({
    kind: f.key,
    label: f.label,
    help: f.help,
    tier: f.tier,
    existingId: storedByKind.get(f.key) ?? null,
  }));
  const { account, ...rest } = project;
  const base = toSafeProject(rest as typeof rest & { anon_key: string | null });
  // Provider-aware, like the dashboard badge: "has credentials the sweep can use", not
  // "has an anon_key" — which is a kind only Supabase has.
  const usableKinds = serverCredentialKinds(project.provider);
  const safe = {
    ...base,
    has_key:
      base.has_key || secrets.some((s) => s.tier === "server" && usableKinds.has(s.kind)),
  };
  // Built with no secrets, so this yields the provider's names for the pair and nothing else
  // — the strings themselves are only ever assembled behind an unlocked vault.
  const connectionLabels = adapter.connectionStrings?.(
    { externalId: project.external_id, name: project.name, metadata: project.metadata },
    {},
  )?.labels;
  const consoleUrl = adapter.consoleUrl({
    externalId: project.external_id,
    name: project.name,
    metadata: project.metadata,
  });

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
          <div className="flex flex-wrap items-center gap-1.5">
            <ProviderBadge provider={project.provider} />
            <code className="text-muted-foreground font-mono text-xs">{project.external_id}</code>
            <LifecycleBadge lifecycle={project.lifecycle} policy={adapter.policy} />
            <StrategyBadge policy={adapter.policy} />
          </div>
          <p className="text-muted-foreground text-[0.8125rem]">
            {account ? (
              <>
                Owned by <strong className="text-foreground font-medium">{account.email}</strong>
                {account.login_method && <> · log in with {account.login_method}</>}
              </>
            ) : (
              "Unassigned"
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <a href={consoleUrl} target="_blank" rel="noreferrer">
              Open in {adapter.name}
              <ArrowUpRightIcon aria-hidden />
            </a>
          </Button>
          {adapter.capabilities.discover && (
            <form action={refreshStatus}>
              <input type="hidden" name="project_id" value={project.id} />
              <SubmitButton variant="ghost" size="sm" pending="Checking…">
                Refresh status
              </SubmitButton>
            </form>
          )}
          {adapter.capabilities.ping && (
            <form action={pingNow}>
              <input type="hidden" name="id" value={project.id} />
              <SubmitButton size="sm" pending="Pinging…">
                Ping now
              </SubmitButton>
            </form>
          )}
        </div>
      </div>

      {(project.lifecycle === "paused" || project.lifecycle === "archived") && (
        <PausedBanner
          projectId={project.id}
          providerName={adapter.name}
          pauseNoun={adapter.policy.pauseNoun}
          canRevive={adapter.capabilities.revive}
          consoleUrl={consoleUrl}
          deletesAfterDays={adapter.policy.deletesAfterDays}
          pausedSince={project.last_pinged_at}
        />
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card>
          <CardContent>
            <ProjectForm
              accounts={accounts}
              slotsUsed={slotsUsed(projects)}
              providers={providerOptions()}
              project={safe}
              keepAliveSql={KEEP_ALIVE_SQL}
            />
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card className="py-0">
            <div className="px-4 pt-4">
              <h2 className="text-sm font-semibold">Recent pings</h2>
            </div>
            {logs.length === 0 ? (
              <p className="text-muted-foreground px-4 pb-4 text-[0.8125rem]">No pings yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead className="text-right">ms</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {new Date(l.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              l.status === "ok" ? "bg-success" : "bg-destructive",
                            )}
                          />
                          <Badge variant={l.status === "ok" ? "success" : "destructive"}>
                            {l.status === "ok" ? "OK" : "Error"}
                          </Badge>
                          {l.http_status ?? ""}
                        </span>
                        {l.via && <div className="text-muted-foreground mt-0.5">{l.via}</div>}
                        {l.error && (
                          <div className="text-destructive mt-0.5 break-words">
                            {l.error.slice(0, 200)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs">
                        {l.duration_ms}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card>
            <CardContent className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Credentials</h2>
                {ready && status?.initialized && !unlocked && (
                  <UnlockDialog
                    otpEnabled={otpAvailable()}
                    lockedUntil={status.lockedUntil}
                    triggerLabel="Unlock vault"
                    triggerVariant="outline"
                  />
                )}
              </div>
              <SecretSlots
                slots={secretSlots}
                projectId={project.id}
                unlocked={unlocked}
                vaultReady={ready && !!status?.initialized}
              />
            </CardContent>
          </Card>

          {hasProviderSetup(project.provider) && (
            <Card>
              <CardContent>
                <ProviderSetup
                  provider={project.provider}
                  storedKinds={[...storedByKind.keys()]}
                />
              </CardContent>
            </Card>
          )}

          {hasPlanLimits(project.provider, project.metadata.instance_size as string | null) && (
            <Card>
              <CardContent>
                <PlanLimits
                  provider={project.provider}
                  instanceSize={project.metadata.instance_size as string | null}
                />
              </CardContent>
            </Card>
          )}

          {adapter.capabilities.watch && (
            <Card>
              <CardContent className="grid gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">Usage this period</h2>
                  <form action={refreshUsage}>
                    <input type="hidden" name="project_id" value={project.id} />
                    <SubmitButton variant="outline" size="sm" pending="Reading…">
                      Refresh
                    </SubmitButton>
                  </form>
                </div>
                <UsageMeters rows={usage} history={usageTrends} />
                <p className="text-muted-foreground text-xs">
                  {adapter.policy.summary}
                </p>
              </CardContent>
            </Card>
          )}

          {adapter.capabilities.health && (
            <Card>
              <CardContent>
                <HealthPanel projectId={project.id} />
              </CardContent>
            </Card>
          )}

          {adapter.connectionStrings && (
            <Card>
              <CardContent className="grid gap-2">
                <h2 className="text-sm font-semibold">Connection strings</h2>
                <ConnectionStrings
                  projectId={project.id}
                  unlocked={unlocked}
                  hasPassword={storedByKind.has("db_password")}
                  labels={connectionLabels}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="grid gap-2">
              <h2 className="text-sm font-semibold">Danger zone</h2>
              <p className="text-muted-foreground text-xs">
                Removes the project from Keepstack&apos;s registry. It does not touch{" "}
                {adapter.name}.
              </p>
              <form action={deleteProject}>
                <input type="hidden" name="id" value={project.id} />
                <SubmitButton
                  variant="destructive"
                  size="sm"
                  confirm={`Remove ${project.name} from the registry? (Doesn't touch ${adapter.name}.)`}
                >
                  Remove from registry
                </SubmitButton>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
