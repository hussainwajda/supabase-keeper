import type { ProviderId } from "@/lib/providers/types";

/**
 * Hard plan limits worth knowing before you hit them.
 *
 * Static facts from docs/PROVIDERS.md, not measured usage — which is why they are a list and
 * not meters. A meter implies a reading; these are ceilings whose current value the provider
 * doesn't publish for free tiers.
 */
const LIMITS: Partial<Record<ProviderId, { plan: string; items: [string, string][]; source: string }>> = {
  mongodb: {
    plan: "M0 (free)",
    items: [
      ["Storage", "0.5 GB"],
      ["Connections", "500"],
      ["Throughput", "100 ops/sec, then throttled"],
      ["Transfer", "10 GB in / 10 GB out per rolling 7 days"],
      ["Namespaces", "100 databases, 500 collections"],
      ["Clusters", "1 free cluster per Atlas project"],
      ["Backups", "Daily snapshots, 4 retained"],
    ],
    source: "https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/",
  },
  upstash: {
    plan: "Free",
    items: [
      ["Data size", "256 MB"],
      ["Commands", "500K / month"],
      ["Bandwidth", "10 GB / month"],
      ["Throughput", "10K commands/sec"],
      ["Databases", "1"],
    ],
    source: "https://upstash.com/pricing/redis",
  },
  appwrite: {
    plan: "Free",
    items: [
      ["Bandwidth", "5 GB"],
      ["Storage", "2 GB"],
      ["Executions", "750K"],
      ["Active users", "75K / month"],
      ["Per project", "1 database, 1 bucket, 2 functions"],
      ["Projects", "2 per organization"],
    ],
    source: "https://appwrite.io/pricing",
  },
};

/** Whether there is anything to show, so the caller doesn't render an empty card. */
export function hasPlanLimits(provider: ProviderId, instanceSize?: string | null): boolean {
  if (!LIMITS[provider]) return false;
  if (provider === "mongodb" && instanceSize && instanceSize !== "M0") return false;
  return true;
}

export function PlanLimits({ provider, instanceSize }: { provider: ProviderId; instanceSize?: string | null }) {
  const limits = LIMITS[provider];
  if (!limits) return null;

  // Only show free-tier limits when the project is actually on the free tier — a paid Atlas
  // cluster has none of these, and showing them would be simply wrong.
  if (provider === "mongodb" && instanceSize && instanceSize !== "M0") return null;

  return (
    <div className="grid gap-2">
      <h2 className="text-sm font-semibold">
        {limits.plan} limits
      </h2>
      <dl className="grid gap-1">
        {limits.items.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 text-xs">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular">{value}</dd>
          </div>
        ))}
      </dl>
      <a
        href={limits.source}
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground text-xs underline underline-offset-4"
      >
        Provider documentation
      </a>
    </div>
  );
}
