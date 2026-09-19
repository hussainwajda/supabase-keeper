// Supabase project refs are 20 lowercase alphanumerics.
const REF = "[a-z0-9]{20}";

/**
 * Pull a project ref out of anything you might paste: a bare ref, an API URL
 * (https://<ref>.supabase.co), a dashboard URL (/dashboard/project/<ref>),
 * a Postgres connection string (postgres.<ref> / db.<ref>.supabase.co) or a whole .env file.
 */
export function extractRef(input: string): string | null {
  const s = input.trim().toLowerCase();
  const patterns = [
    new RegExp(`(${REF})\\.supabase\\.(?:co|in)`),
    new RegExp(`/project/(${REF})`),
    new RegExp(`postgres\\.(${REF})`),
    new RegExp(`^(${REF})$`),
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return null;
}

export function dashboardUrl(ref: string) {
  return `https://supabase.com/dashboard/project/${ref}`;
}
