import type { ProviderId } from "@/lib/providers/types";
import { AtlasSetup } from "./atlas-setup";
import { UpstashSetup } from "./upstash-setup";

/**
 * Per-provider setup guidance.
 *
 * The adapter contract says the UI renders from `capabilities` and `policy` rather than
 * branching on which provider it holds — and that holds for every *behaviour*. Prose is the
 * exception: "what 0.0.0.0/0 actually means" can't be derived from a capability flag. So the
 * branch exists, and it exists exactly once, here, instead of being sprinkled through pages.
 *
 * A provider with nothing special to explain simply isn't in the map, and the caller renders
 * no card at all.
 */
const PANELS: Partial<Record<ProviderId, (stored: Set<string>) => React.ReactNode>> = {
  mongodb: (stored) => <AtlasSetup hasConnectionString={stored.has("connection_string")} />,
  upstash: (stored) => <UpstashSetup hasRestToken={stored.has("rest_token")} />,
};

export function hasProviderSetup(provider: ProviderId): boolean {
  return provider in PANELS;
}

export function ProviderSetup({
  provider,
  storedKinds,
}: {
  provider: ProviderId;
  /** Secret kinds already stored for this project, so the panel can show what's missing. */
  storedKinds: string[];
}) {
  const panel = PANELS[provider];
  return panel ? <>{panel(new Set(storedKinds))}</> : null;
}
