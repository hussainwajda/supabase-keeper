import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Lifecycle, Policy, ProviderId } from "@/lib/providers/types";

const PROVIDER_LABEL: Record<ProviderId, string> = {
  supabase: "Supabase",
  neon: "Neon",
  mongodb: "MongoDB Atlas",
  upstash: "Upstash",
  appwrite: "Appwrite",
};

/** Each provider's accent is a token, never a hex literal in a component. */
const PROVIDER_DOT: Record<ProviderId, string> = {
  supabase: "bg-provider-supabase",
  neon: "bg-provider-neon",
  mongodb: "bg-provider-mongodb",
  upstash: "bg-provider-upstash",
  appwrite: "bg-provider-appwrite",
};

export function ProviderBadge({ provider, className }: { provider: ProviderId; className?: string }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-normal", className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full", PROVIDER_DOT[provider])} aria-hidden />
      {PROVIDER_LABEL[provider]}
    </Badge>
  );
}

const LIFECYCLE_COPY: Record<Lifecycle, { label: string; variant: "success" | "warning" | "destructive" | "muted" }> = {
  active: { label: "Active", variant: "success" },
  idle: { label: "Transitioning", variant: "muted" },
  paused: { label: "Paused", variant: "destructive" },
  archived: { label: "Archived", variant: "destructive" },
  deleted: { label: "Deleted", variant: "destructive" },
  unknown: { label: "Unknown", variant: "muted" },
};

/**
 * Status never relies on colour alone — the label carries the meaning, so the badge is
 * readable in greyscale and to a screen reader.
 */
export function LifecycleBadge({
  lifecycle,
  policy,
  className,
}: {
  lifecycle: Lifecycle;
  policy?: Policy;
  className?: string;
}) {
  const { label, variant } = LIFECYCLE_COPY[lifecycle] ?? LIFECYCLE_COPY.unknown;
  // Use the provider's own word where it differs: Upstash archives, Aiven powers off.
  const text = lifecycle === "paused" && policy ? capitalize(policy.pauseNoun) : label;
  return (
    <Badge variant={variant} className={className}>
      {text}
    </Badge>
  );
}

/** The keep-alive model, so a `watch` provider never looks like a broken `ping` one. */
export function StrategyBadge({ policy }: { policy: Policy }) {
  const copy = {
    ping: { label: "Keep-alive", hint: "Pinged on a schedule to reset the inactivity clock" },
    watch: { label: "Quota watch", hint: "No pausing — Keepstack watches usage instead of pinging" },
    alert_only: { label: "Alerts only", hint: "Keepstack detects and warns, but cannot prevent the pause" },
  }[policy.strategy];

  return (
    <Badge variant={policy.strategy === "ping" ? "default" : "muted"} title={copy.hint}>
      {copy.label}
    </Badge>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export { PROVIDER_LABEL };
