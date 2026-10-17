import { ExternalLinkIcon, ShieldAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/buttons";

/**
 * Atlas keep-alive setup, including the network trade-off stated plainly.
 *
 * This is the only provider where keeping a project alive requires widening its network
 * access, so the UI explains what that means rather than burying it in a help string. A user
 * who declines gets a working alerts-only setup, which is said here too — the choice should
 * feel like a choice, not a dead end.
 */
const PING_USER_STEPS = [
  {
    title: "Create a read-only database user",
    body: "Atlas → Database Access → Add New Database User. Name it keepstack-ping, give it a long generated password, and set its role to Only read any database. Never reuse your application's user: this credential has to be readable by the server unattended, so it should be able to do as little as possible.",
  },
  {
    title: "Allow the server to connect",
    body: "Atlas → Network Access → Add IP Address. A serverless host like Vercel has no fixed outbound IP, so this has to be 0.0.0.0/0 — see the warning below. Self-hosting on a box with a static IP? Allow just that address instead.",
  },
  {
    title: "Copy the connection string",
    body: "Atlas → Connect → Drivers, then substitute the keepstack-ping user and its password. URL-encode the password if it contains @ : / ? # or %. Paste it into the Keep-alive connection string field above.",
  },
];

export function AtlasSetup({ hasConnectionString }: { hasConnectionString: boolean }) {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Keep-alive setup</h2>
        {hasConnectionString ? (
          <Badge variant="success">Connection string stored</Badge>
        ) : (
          <Badge variant="warning">Alerts only</Badge>
        )}
      </div>

      {!hasConnectionString && (
        <p className="text-muted-foreground text-[0.8125rem]">
          Without a connection string, Keepstack reads this cluster&apos;s status and warns you
          before the 30-day pause — but can&apos;t prevent it. Atlas counts{" "}
          <em>connections</em>, and the Data API that once allowed an HTTP query was removed in
          September 2025, so a real driver connection is the only thing that resets the clock.
        </p>
      )}

      <ol className="grid gap-3">
        {PING_USER_STEPS.map((step, i) => (
          <li key={step.title} className="grid gap-0.5">
            <span className="text-[0.8125rem] font-medium">
              {i + 1}. {step.title}
            </span>
            <span className="text-muted-foreground text-xs">{step.body}</span>
          </li>
        ))}
      </ol>

      <div className="border-warning/50 bg-warning/5 grid gap-2 rounded-md border p-3">
        <h3 className="text-warning flex items-center gap-2 text-[0.8125rem] font-semibold">
          <ShieldAlertIcon className="size-4" aria-hidden />
          What 0.0.0.0/0 actually means
        </h3>
        <p className="text-[0.8125rem]">
          Your cluster becomes reachable from <strong className="font-medium">any</strong> IP
          address on the internet. The only thing protecting it is the strength of its database
          passwords.
        </p>
        <ul className="text-muted-foreground grid list-disc gap-1 pl-5 text-xs">
          <li>
            This is why step 1 matters: a leaked <code className="font-mono">keepstack-ping</code>{" "}
            credential should expose read access, not write access, and definitely not admin.
          </li>
          <li>
            Use a long generated password for <em>every</em> user on the cluster, not just this
            one — widening network access widens it for all of them.
          </li>
          <li>
            On a host with a fixed outbound IP, allow that single address and skip this
            entirely.
          </li>
          <li>
            Not comfortable with it? Leave the connection string blank. Alerts-only still gives
            you 7 days&apos; warning, which is the same notice Atlas emails you.
          </li>
        </ul>
      </div>

      <details className="text-[0.8125rem]">
        <summary className="text-muted-foreground cursor-pointer">
          Create the read-only user with the Atlas CLI instead
        </summary>
        <pre className="bg-muted mt-2 overflow-x-auto rounded-md p-3 font-mono text-xs">
          {ATLAS_CLI}
        </pre>
        <div className="mt-2">
          <CopyButton text={ATLAS_CLI} label="Copy commands" size="sm" variant="outline" />
        </div>
      </details>

      <a
        href="https://www.mongodb.com/docs/atlas/security/ip-access-list/"
        target="_blank"
        rel="noreferrer"
        className="text-accent inline-flex items-center gap-1 text-xs underline underline-offset-4"
      >
        Atlas IP access list documentation
        <ExternalLinkIcon className="size-3" aria-hidden />
      </a>
    </div>
  );
}

const ATLAS_CLI = `# Read-only user for keep-alive pings only
atlas dbusers create readAnyDatabase \\
  --username keepstack-ping \\
  --projectId <PROJECT_ID>

# Allow your server's IP. Use 0.0.0.0/0 only if it has no fixed address,
# and read the warning above first.
atlas accessLists create 0.0.0.0/0 \\
  --type cidrBlock \\
  --comment "keepstack keep-alive" \\
  --projectId <PROJECT_ID>`;
