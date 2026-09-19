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

// Free-plan projects pause after 7 days without activity.
export function daysUntilPauseRisk(lastIso: string | null): number | null {
  if (!lastIso) return null;
  return 7 - (Date.now() - new Date(lastIso).getTime()) / 86_400_000;
}
