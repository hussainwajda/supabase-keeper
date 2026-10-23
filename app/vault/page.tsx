import Link from "next/link";
import {
  ClockIcon,
  KeyRoundIcon,
  LockIcon,
  LockOpenIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { currentUser } from "@/lib/backend/user";
import { listAccounts, listProjects } from "@/lib/registry";
import { vaultEnvProblems } from "@/lib/crypto/env";
import { listVaultSessions, vaultSessionRemaining, vaultStatus, vaultUnlocked } from "@/lib/vault";
import { listSecrets, vaultSchemaReady } from "@/lib/vault/secrets";
import { otpAvailable } from "@/lib/vault/email";
import { listAuditEntries } from "@/lib/vault/audit";
import { lockEverywhere, lockNow } from "@/app/vault/actions";
import { SubmitButton } from "@/components/buttons";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PinSetup } from "@/components/vault/pin-setup";
import { RecoveryToggle } from "@/components/vault/recovery-toggle";
import { RevealField } from "@/components/vault/reveal-field";
import { UnlockDialog } from "@/components/vault/unlock-dialog";
import { timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  account_password: "Account login password",
  pat: "Personal access token",
  api_key: "API key",
  api_email: "API account email",
  service_account: "Service account secret",
  db_password: "Database password",
  anon_key: "Anon / publishable key",
  connection_string: "Connection string",
  rest_token: "REST token",
};

const ACTION_LABEL: Record<string, string> = {
  "vault.pin_set": "PIN set",
  "vault.pin_changed": "PIN changed",
  "vault.pin_reset": "PIN reset by email code",
  "vault.unlock": "Vault unlocked",
  "vault.unlock_failed": "Failed unlock attempt",
  "vault.locked_out": "Vault locked after repeated failures",
  "vault.otp_sent": "Email code sent",
  "vault.recovery_disabled": "Email recovery turned off",
  "vault.lock": "Vault locked",
  "secret.create": "Secret stored",
  "secret.update": "Secret updated",
  "secret.delete": "Secret deleted",
  "secret.reveal": "Secret revealed",
  "secret.migrated": "Keys moved into the vault",
  "registry.claim_legacy": "Legacy rows claimed",
};

export default async function VaultPage() {
  const user = await currentUser();
  if (!user) return null; // middleware already redirects; this satisfies the type.

  const envProblems = vaultEnvProblems();

  if (envProblems.length > 0) {
    return (
      <>
        <PageHead />
        <Card className="border-warning/50 bg-warning/5">
          <CardContent className="grid gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <TriangleAlertIcon className="text-warning size-4" aria-hidden />
              The vault isn&apos;t configured
            </h2>
            <ul className="text-muted-foreground grid list-disc gap-1 pl-5 text-[0.8125rem]">
              {envProblems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="text-muted-foreground text-[0.8125rem]">
              Generate each with <code className="font-mono">openssl rand -base64 32</code> and add
              them to your environment. Back{" "}
              <code className="font-mono">KEEPSTACK_MASTER_KEY</code> up to a password manager
              before storing anything: losing it makes every server-tier secret unrecoverable.
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  if (!(await vaultSchemaReady())) {
    return (
      <>
        <PageHead />
        <Card className="border-warning/50 bg-warning/5">
          <CardContent className="grid gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <TriangleAlertIcon className="text-warning size-4" aria-hidden />
              One migration pending
            </h2>
            <p className="text-muted-foreground text-[0.8125rem]">
              The vault tables don&apos;t exist yet. Run{" "}
              <code className="font-mono">supabase/migrations/0005_vault.sql</code> in your
              registry project&apos;s SQL editor, then reload. Everything else in Keepstack keeps
              working in the meantime.
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  const [status, unlocked, remaining, secrets, sessions, accounts, projects] = await Promise.all([
    vaultStatus(user.id),
    vaultUnlocked(user.id),
    vaultSessionRemaining(user.id),
    listSecrets(),
    listVaultSessions(user.id),
    listAccounts(),
    listProjects(),
  ]);

  const auditLog = await listAuditEntries(user.id, 40);

  const accountName = new Map(accounts.map((a) => [a.id, a.label ?? a.email]));
  const projectName = new Map(projects.map((p) => [p.id, p.name]));

  function ownerOf(s: { account_id: string | null; project_id: string | null }) {
    if (s.project_id) return projectName.get(s.project_id) ?? "deleted project";
    if (s.account_id) return accountName.get(s.account_id) ?? "deleted account";
    return "—";
  }

  return (
    <>
      <PageHead />

      <div className="mb-4 grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-1">
              <div className="flex items-center gap-2">
                {unlocked ? (
                  <Badge variant="success">
                    <LockOpenIcon aria-hidden />
                    Unlocked
                  </Badge>
                ) : (
                  <Badge variant="muted">
                    <LockIcon aria-hidden />
                    Locked
                  </Badge>
                )}
                {status.initialized ? (
                  <Badge variant="outline">PIN set</Badge>
                ) : (
                  <Badge variant="warning">No PIN yet</Badge>
                )}
                {status.initialized &&
                  (status.recoveryEnabled ? (
                    <Badge variant="outline">Email recovery on</Badge>
                  ) : (
                    <Badge variant="outline">No recovery</Badge>
                  ))}
              </div>
              <p className="text-muted-foreground text-[0.8125rem]">
                {unlocked
                  ? `Sudo window closes in about ${Math.ceil(remaining / 60)} minute${Math.ceil(remaining / 60) === 1 ? "" : "s"}.`
                  : status.initialized
                    ? "Unlock to reveal or store personal secrets."
                    : "Set a PIN to start storing passwords."}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {status.initialized && !unlocked && (
                <UnlockDialog otpEnabled={otpAvailable()} lockedUntil={status.lockedUntil} />
              )}
              {unlocked && (
                <>
                  <form action={lockNow}>
                    <SubmitButton variant="outline" size="sm" pending="Locking…">
                      <LockIcon aria-hidden />
                      Lock now
                    </SubmitButton>
                  </form>
                  <form action={lockEverywhere}>
                    <SubmitButton variant="ghost" size="sm" pending="Locking…">
                      Lock everywhere
                    </SubmitButton>
                  </form>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid gap-1">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheckIcon className="text-accent size-4" aria-hidden />
              How this works
            </h2>
            <p className="text-muted-foreground text-xs">
              <strong className="text-foreground font-medium">Personal</strong> secrets — account
              logins, database passwords — are encrypted with a key wrapped by your PIN.{" "}
              <strong className="text-foreground font-medium">Server</strong> secrets — provider
              API keys — must stay machine-readable so the nightly sweep can use them unattended.
            </p>
            <Link
              href="https://github.com/hussainwajda/keepstack/blob/main/docs/SECURITY.md"
              className="text-accent text-xs underline underline-offset-4"
              target="_blank"
              rel="noreferrer"
            >
              Read the threat model, including the limits
            </Link>
          </CardContent>
        </Card>
      </div>

      {status.lockedUntil && (
        <Card className="border-destructive/50 bg-destructive/5 mb-4">
          <CardContent>
            <p className="text-[0.8125rem]">
              <strong className="font-medium">The PIN is locked</strong> until{" "}
              {new Date(status.lockedUntil).toLocaleTimeString()} after repeated wrong attempts.
              {otpAvailable()
                ? " You can still unlock with an email code."
                : " Email codes aren't configured, so you'll have to wait it out."}
            </p>
          </CardContent>
        </Card>
      )}

      <Card className="mb-4">
        <CardContent className="grid gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRoundIcon className="size-4" aria-hidden />
            {status.initialized ? "Change your PIN" : "Set your PIN"}
          </h2>
          <PinSetup mode={status.initialized ? "change" : "create"} unlocked={unlocked} />
        </CardContent>
      </Card>

      <Card className="mb-4 py-0">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
          <h2 className="text-sm font-semibold">Stored secrets ({secrets.length})</h2>
          {!unlocked && status.initialized && (
            <UnlockDialog
              otpEnabled={otpAvailable()}
              lockedUntil={status.lockedUntil}
              triggerLabel="Unlock to reveal"
              triggerVariant="outline"
            />
          )}
        </div>

        {secrets.length === 0 ? (
          <p className="text-muted-foreground px-4 pb-4 text-[0.8125rem]">
            Nothing stored yet. Passwords and tokens are added from an account or project page.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Secret</TableHead>
                <TableHead>Belongs to</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead className="hidden md:table-cell">Last used</TableHead>
                <TableHead>Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {secrets.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="text-[0.8125rem] font-medium">
                      {KIND_LABEL[s.kind] ?? s.kind}
                    </div>
                    {s.label && <div className="text-muted-foreground text-xs">{s.label}</div>}
                  </TableCell>
                  <TableCell className="text-[0.8125rem]">{ownerOf(s)}</TableCell>
                  <TableCell>
                    <Badge variant={s.tier === "personal" ? "success" : "muted"}>
                      {s.tier === "personal" ? "Personal" : "Server"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                    <span suppressHydrationWarning>{timeAgo(s.last_used_at)}</span>
                  </TableCell>
                  <TableCell className="min-w-[260px]">
                    <RevealField
                      secretId={s.id}
                      label={KIND_LABEL[s.kind] ?? s.kind}
                      disabled={!unlocked}
                      disabledReason="Locked — unlock the vault above."
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="grid gap-3">
            <h2 className="text-sm font-semibold">Email recovery</h2>
            <RecoveryToggle enabled={status.recoveryEnabled} unlocked={unlocked} />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ClockIcon className="size-4" aria-hidden />
              Active sudo sessions ({sessions.length})
            </h2>
            {sessions.length === 0 ? (
              <p className="text-muted-foreground text-[0.8125rem]">None.</p>
            ) : (
              <ul className="grid gap-2">
                {sessions.map((s) => (
                  <li key={s.id} className="text-[0.8125rem]">
                    <span className="font-medium">
                      {s.method === "pin" ? "PIN" : "Email code"}
                    </span>{" "}
                    <span className="text-muted-foreground" suppressHydrationWarning>
                      · opened {timeAgo(s.created_at)} · expires{" "}
                      {new Date(s.expires_at).toLocaleTimeString()}
                    </span>
                    {s.ip && <div className="text-muted-foreground text-xs">{s.ip}</div>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4 py-0">
        <div className="px-4 pt-4">
          <h2 className="text-sm font-semibold">Audit log</h2>
          <p className="text-muted-foreground text-xs">
            Every vault action, including failures. Values are never recorded.
          </p>
        </div>
        {auditLog.length === 0 ? (
          <p className="text-muted-foreground px-4 pb-4 pt-2 text-[0.8125rem]">Nothing yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="hidden md:table-cell">Detail</TableHead>
                <TableHead className="hidden lg:table-cell">From</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auditLog.map((row) => {
                const failed = row.action.includes("failed") || row.action.includes("locked_out");
                return (
                  <TableRow key={row.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {new Date(row.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge variant={failed ? "destructive" : "muted"}>
                        {ACTION_LABEL[row.action] ?? row.action}
                      </Badge>
                      {row.method && (
                        <span className="text-muted-foreground ml-1.5">via {row.method}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                      {Object.entries(row.detail ?? {})
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(", ") || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-xs lg:table-cell">
                      {row.ip ?? "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}

function PageHead() {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold tracking-tight">Vault</h1>
      <p className="text-muted-foreground text-[0.8125rem]">
        Encrypted passwords and tokens, revealed only after you re-authenticate.
      </p>
    </div>
  );
}
