import type { Policy } from "@/lib/providers/types";

export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function nextPingLabel(lastIso: string | null, intervalDays: number, enabled: boolean): string {
  if (!enabled) return "off";
  if (!lastIso) return "next cron run";
  const due = new Date(lastIso).getTime() + intervalDays * 86_400_000;
  const days = Math.ceil((due - Date.now()) / 86_400_000);
  return days <= 0 ? "next cron run" : `in ~${days}d`;
}

/**
 * Days until the provider pauses this project for inactivity.
 *
 * Reads the window from the provider's own policy instead of assuming Supabase's 7 days —
 * Atlas allows 30, Upstash ~14, Appwrite 7. Returns null when the provider has no
 * inactivity policy (Neon) or we've never seen activity.
 */
export function daysUntilPauseRisk(lastIso: string | null, policy: Policy): number | null {
  if (!lastIso || policy.pausesAfterDays === null) return null;
  return policy.pausesAfterDays - (Date.now() - new Date(lastIso).getTime()) / 86_400_000;
}

/** A pause-risk window is "urgent" inside the last 30% of the provider's grace period. */
export function isUrgentRisk(daysLeft: number | null, policy: Policy): boolean {
  if (daysLeft === null || policy.pausesAfterDays === null) return false;
  return daysLeft < Math.max(1.5, policy.pausesAfterDays * 0.3);
}
