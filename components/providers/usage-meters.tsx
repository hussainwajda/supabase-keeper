import { AlertTriangleIcon, CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import type { UsageRow } from "@/lib/usage";
import { daysOfHeadroom, usageFraction } from "@/lib/usage";
import { cn } from "@/lib/utils";

/**
 * Quota meters for `watch` providers.
 *
 * A meter, not a chart: each row is one ratio against a limit, which is the case where a
 * same-ramp track beats any chart type. The fill carries severity and the unfilled track is a
 * lighter step of the same ramp, so the state reads across the whole bar rather than only
 * where the fill ends.
 *
 * Severity never travels by colour alone — every row carries an icon and a worded status, so
 * it survives greyscale, CVD and a screen reader.
 */

const METRIC_LABEL: Record<string, string> = {
  compute_cu_hours: "Compute",
  storage_bytes: "Storage",
  transfer_bytes: "Data transfer",
  commands: "Commands",
  rows_read: "Rows read",
};

function formatValue(row: UsageRow): string {
  if (row.unit === "bytes") return formatBytes(row.value);
  if (row.metric === "compute_cu_hours") return `${round(row.value, 1)}`;
  return compact(row.value);
}

function formatLimit(row: UsageRow): string | null {
  if (row.limit_value === null) return null;
  if (row.unit === "bytes") return formatBytes(row.limit_value);
  if (row.metric === "compute_cu_hours") return `${round(row.limit_value, 0)} CU-hours`;
  return compact(row.limit_value);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${round(v, v < 10 ? 2 : 1)} ${units[i]}`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${round(n / 1_000_000, 1)}M`;
  if (n >= 1_000) return `${round(n / 1_000, 1)}K`;
  return String(Math.round(n));
}

function round(n: number, places: number): string {
  return n.toFixed(places).replace(/\.0+$/, "");
}

type Severity = "ok" | "warning" | "critical";

function severityOf(fraction: number | null, headroom: number | null): Severity {
  if (fraction !== null && fraction >= 0.9) return "critical";
  if (headroom !== null && headroom <= 3) return "critical";
  if (fraction !== null && fraction >= 0.7) return "warning";
  if (headroom !== null && headroom <= 7) return "warning";
  return "ok";
}

const SEVERITY = {
  ok: { fill: "bg-success", ink: "text-success", Icon: CircleCheckIcon, word: "Healthy" },
  warning: { fill: "bg-warning", ink: "text-warning", Icon: AlertTriangleIcon, word: "Watch" },
  critical: { fill: "bg-destructive", ink: "text-destructive", Icon: CircleAlertIcon, word: "At risk" },
} as const;

export function UsageMeters({ rows, history }: { rows: UsageRow[]; history?: Record<string, UsageRow[]> }) {
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No usage recorded yet. The nightly sweep reads it, or press Refresh above.
      </p>
    );
  }

  return (
    <ul className="grid gap-4">
      {rows.map((row) => {
        const fraction = usageFraction(row);
        const headroom = daysOfHeadroom(row);
        const severity = severityOf(fraction, headroom);
        const { fill, ink, Icon, word } = SEVERITY[severity];
        const limit = formatLimit(row);
        const pct = fraction === null ? null : Math.min(100, Math.max(0, fraction * 100));

        return (
          <li key={row.metric} className="grid gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-[0.8125rem] font-medium">
                {METRIC_LABEL[row.metric] ?? row.metric}
              </span>
              <span className="text-muted-foreground text-xs tabular">
                <span className="text-foreground font-semibold">{formatValue(row)}</span>
                {limit && <> / {limit}</>}
                {pct !== null && <> · {Math.round(pct)}%</>}
              </span>
            </div>

            {pct !== null ? (
              <div
                className="bg-meter-track h-2 w-full overflow-hidden rounded-full"
                role="meter"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${METRIC_LABEL[row.metric] ?? row.metric}: ${formatValue(row)} of ${limit ?? "no limit"}`}
              >
                {/* 4px rounded data-end; square where it meets the baseline at 0. */}
                <div
                  className={cn("h-full rounded-r-[4px] transition-[width] duration-300", fill)}
                  style={{ width: `${Math.max(pct, pct > 0 ? 1.5 : 0)}%` }}
                />
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">No published limit for this metric.</p>
            )}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className={cn("inline-flex items-center gap-1", ink)}>
                <Icon className="size-3.5" aria-hidden />
                {word}
              </span>

              {headroom !== null && (
                <span className="text-muted-foreground">
                  {headroom <= 0
                    ? "allowance spent for this period"
                    : `~${round(headroom, headroom < 10 ? 1 : 0)} days left at this rate`}
                </span>
              )}

              {history?.[row.metric] && history[row.metric].length > 2 && (
                <Sparkline rows={history[row.metric]} severity={severity} />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A 12-point sparkline of recent readings. Context for the meter, so it carries no axes,
 * labels or tooltip — the meter above it is what gets read.
 */
function Sparkline({ rows, severity }: { rows: UsageRow[]; severity: Severity }) {
  const points = rows.slice(-12);
  const values = points.map((r) => r.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  const w = 56;
  const h = 14;
  const step = points.length > 1 ? w / (points.length - 1) : w;

  const path = points
    .map((p, i) => {
      const x = i * step;
      const y = h - ((p.value - min) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const last = points[points.length - 1];
  const lastX = (points.length - 1) * step;
  const lastY = h - ((last.value - min) / span) * h;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="overflow-visible"
      role="img"
      aria-label={`Trend over the last ${points.length} readings`}
    >
      {/* Trend line in the de-emphasis ink; only the current point takes the status colour. */}
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-muted-foreground/50"
      />
      <circle
        cx={lastX}
        cy={lastY}
        r={2.5}
        className={severity === "ok" ? "fill-success" : severity === "warning" ? "fill-warning" : "fill-destructive"}
      />
    </svg>
  );
}
