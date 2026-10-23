import { ExternalLinkIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * Upstash keep-alive setup.
 *
 * Two things here are not in the docs in one place, and both bite people months later: the
 * Developer API doesn't exist for accounts created through Vercel or Fly.io, and the
 * inactivity window is published as both 14 and 30 days with no date on either page.
 */
const STEPS = [
  {
    title: "Copy the REST token",
    body: "Upstash console → your database → REST API. The token is UPSTASH_REDIS_REST_TOKEN. Save it under Credentials above and the keep-alive works immediately — no management key needed.",
  },
  {
    title: "Optional: add a Developer API key",
    body: "Console → Account → Management API → Create API key, then save it with your account email under the account's Credentials. That buys automatic discovery, status reads, the command-budget meter, and fetching REST tokens for you.",
  },
];

export function UpstashSetup({ hasRestToken }: { hasRestToken: boolean }) {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Keep-alive setup</h2>
        {hasRestToken ? (
          <Badge variant="success">REST token stored</Badge>
        ) : (
          <Badge variant="warning">No token yet</Badge>
        )}
      </div>

      {!hasRestToken && (
        <p className="text-muted-foreground text-[0.8125rem]">
          Without a REST token Keepstack can&apos;t ping this database, so nothing is resetting
          its inactivity clock. The ping is a single <code className="font-mono">GET /ping</code>{" "}
          — about 30 commands a year against the 500,000/month allowance.
        </p>
      )}

      <ol className="grid gap-3">
        {STEPS.map((step, i) => (
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
          <TriangleAlertIcon className="size-4" aria-hidden />
          Archiving removes the instance
        </h3>
        <p className="text-[0.8125rem]">
          An idle free database is archived: Upstash takes a backup and tears down the instance.
          Your data survives, but recovery is{" "}
          <strong className="font-medium">console-only</strong> — create a new database and
          import the backup. There is no API for it, so Keepstack can&apos;t undo an archive.
        </p>
        <ul className="text-muted-foreground grid list-disc gap-1 pl-5 text-xs">
          <li>
            The published window is <strong className="font-medium">14 days in one place and
            30 in another</strong>, neither dated. Keepstack assumes 14 and pings every 7, so it
            errs towards pinging sooner than needed rather than too late.
          </li>
          <li>
            Upstash emails warnings first. Those are worth not filtering — they are the only
            notice tied to the real clock.
          </li>
        </ul>
      </div>

      <div className="border-destructive/50 bg-destructive/5 grid gap-2 rounded-md border p-3">
        <h3 className="text-destructive flex items-center gap-2 text-[0.8125rem] font-semibold">
          <TriangleAlertIcon className="size-4" aria-hidden />
          Not a database from <code className="font-mono">/start-redis</code>?
        </h3>
        <p className="text-[0.8125rem]">
          Upstash&apos;s no-signup databases are{" "}
          <strong className="font-medium">deleted after 3 days</strong> unless you claim them
          into a real account. Pinging does not save one. If this is such a database, claim it in
          the console now — a keep-alive here would be a false sense of safety.
        </p>
      </div>

      <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          Accounts created through the Vercel or Fly.io integrations have no Management API
          section, so discovery and the quota meter aren&apos;t available for them. The REST
          token still works, which is why the ping only needs that.
        </span>
      </p>

      <a
        href="https://upstash.com/docs/redis/help/faq"
        target="_blank"
        rel="noreferrer"
        className="text-accent inline-flex items-center gap-1 text-xs underline underline-offset-4"
      >
        Upstash FAQ on inactivity
        <ExternalLinkIcon className="size-3" aria-hidden />
      </a>
    </div>
  );
}
