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
import { deleteProject, pingNow } from "@/app/actions";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [project, accounts, projects, logs] = await Promise.all([
    getProject(id),
    listAccounts(),
    listProjects(),
    recentLogs(id),
  ]);
  if (!project) notFound();

  const adapter = getProvider(project.provider);
  const { account, ...rest } = project;
  const safe = toSafeProject(rest as typeof rest & { anon_key: string | null });
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
          <form action={pingNow}>
            <input type="hidden" name="id" value={project.id} />
            <SubmitButton size="sm" pending="Pinging…">
              Ping now
            </SubmitButton>
          </form>
        </div>
      </div>

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
