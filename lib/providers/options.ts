import "server-only";
import { activeProviders } from "./registry";
import type { CredentialField, ProviderId } from "./types";

/**
 * Serialisable provider metadata for client components.
 *
 * `CredentialField.validate` is a function, so it cannot cross the server/client boundary.
 * Validation still runs server-side in `saveProject`; this strips the callback and keeps the
 * descriptive half of the field. Any field added to an adapter shows up in the form for free.
 */
export type SerializableField = Omit<CredentialField, "validate">;

export type ProviderOption = {
  id: ProviderId;
  name: string;
  policy: ReturnType<typeof policyOf>;
  projectFields: SerializableField[];
  identifierLabel: string;
  identifierHint: string;
  identifierPlaceholder: string;
};

function policyOf(id: ProviderId) {
  const adapter = activeProviders().find((a) => a.id === id);
  if (!adapter) throw new Error(`No adapter for ${id}`);
  return { ...adapter.policy };
}

/** How each provider labels the thing that identifies a project. */
const IDENTIFIER: Record<ProviderId, { label: string; hint: string; placeholder: string }> = {
  supabase: {
    label: "Project URL or ref",
    hint: "Paste the API URL, a dashboard link, a connection string, or the 20-character ref.",
    placeholder: "https://abcdefghijklmnopqrst.supabase.co",
  },
  neon: {
    label: "Project ID",
    hint: "From the Neon console URL, or paste a connection string.",
    placeholder: "fragrant-dew-12345678",
  },
  mongodb: {
    label: "Cluster name",
    hint: "The cluster name in Atlas, or paste its SRV connection string.",
    placeholder: "Cluster0",
  },
  upstash: {
    label: "Database ID or endpoint",
    hint: "From the Upstash console, or paste the REST endpoint host.",
    placeholder: "xxx-yyy-12345.upstash.io",
  },
  appwrite: {
    label: "Project ID",
    hint: "Appwrite console → Settings → Project ID.",
    placeholder: "65f0a1b2c3d4e5f60718",
  },
};

export function providerOptions(): ProviderOption[] {
  return activeProviders().map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    policy: { ...adapter.policy },
    projectFields: adapter.projectFields.map(({ validate: _validate, ...field }) => field),
    identifierLabel: IDENTIFIER[adapter.id].label,
    identifierHint: IDENTIFIER[adapter.id].hint,
    identifierPlaceholder: IDENTIFIER[adapter.id].placeholder,
  }));
}
