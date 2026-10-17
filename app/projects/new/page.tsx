import { listAccounts, listProjects, slotsUsed } from "@/lib/registry";
import { providerOptions } from "@/lib/providers/options";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/types";
import { ProjectForm } from "@/components/project-form";
import { Card, CardContent } from "@/components/ui/card";
import { KEEP_ALIVE_SQL } from "@/lib/keep-alive-sql";

export const dynamic = "force-dynamic";

export default async function NewProject({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string; provider?: string }>;
}) {
  const [params, accounts, projects] = await Promise.all([
    searchParams,
    listAccounts(),
    listProjects(),
  ]);

  const provider = PROVIDER_IDS.includes(params.provider as ProviderId)
    ? (params.provider as ProviderId)
    : undefined;

  return (
    <>
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Add project</h1>
        <p className="text-muted-foreground text-[0.8125rem]">
          Register a database so Keepstack can tell you who owns it — and keep it from pausing.
        </p>
      </div>

      <Card className="max-w-3xl">
        <CardContent>
          <ProjectForm
            accounts={accounts}
            slotsUsed={slotsUsed(projects)}
            providers={providerOptions()}
            defaultProvider={provider}
            defaultExternalId={params.ref}
            keepAliveSql={KEEP_ALIVE_SQL}
          />
        </CardContent>
      </Card>
    </>
  );
}
