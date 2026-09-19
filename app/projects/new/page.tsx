import { listAccounts, listProjects } from "@/lib/db";
import { ProjectForm } from "@/components/project-form";
import { KEEP_ALIVE_SQL } from "@/lib/keep-alive-sql";

export const dynamic = "force-dynamic";

export default async function NewProject({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  const [{ ref }, accounts, projects] = await Promise.all([searchParams, listAccounts(), listProjects()]);
  const slotsUsed: Record<string, number> = {};
  for (const p of projects) if (p.account_id) slotsUsed[p.account_id] = (slotsUsed[p.account_id] ?? 0) + 1;

  return (
    <>
      <div className="page-head"><h1>Add project</h1></div>
      <div className="card">
        <ProjectForm accounts={accounts} slotsUsed={slotsUsed} defaultRef={ref} keepAliveSql={KEEP_ALIVE_SQL} />
      </div>
    </>
  );
}
