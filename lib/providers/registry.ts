import { mongodbAdapter } from "./mongodb";
import { neonAdapter } from "./neon";
import { supabaseAdapter } from "./supabase";
import { PROVIDER_IDS, type ProviderAdapter, type ProviderId } from "./types";

/**
 * The only place that knows which adapters exist.
 *
 * Adding a provider is one file here, one line in this map, and one section in
 * docs/PROVIDERS.md. Phases 6-7 fill in upstash and appwrite.
 */
const ADAPTERS: Partial<Record<ProviderId, ProviderAdapter>> = {
  supabase: supabaseAdapter,
  neon: neonAdapter,
  mongodb: mongodbAdapter,
};

/** Adapters that are implemented and safe to use today. */
export function activeProviders(): ProviderAdapter[] {
  return PROVIDER_IDS.map((id) => ADAPTERS[id]).filter((a): a is ProviderAdapter => !!a);
}

export function getProvider(id: ProviderId): ProviderAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(
      `No adapter is registered for provider "${id}". Implemented: ${activeProviders()
        .map((a) => a.id)
        .join(", ")}.`,
    );
  }
  return adapter;
}

export function isImplemented(id: ProviderId): boolean {
  return !!ADAPTERS[id];
}

/**
 * Paste-anything search across every active provider.
 *
 * Returns the first provider that recognises the input. Order follows PROVIDER_IDS, so a
 * string that two providers could claim resolves deterministically rather than by map order.
 */
export function parseIdentifier(
  input: string,
): { provider: ProviderId; externalId: string; hint?: string } | null {
  if (!input.trim()) return null;
  for (const adapter of activeProviders()) {
    const parsed = adapter.parse(input);
    if (parsed) return { provider: adapter.id, ...parsed };
  }
  return null;
}
