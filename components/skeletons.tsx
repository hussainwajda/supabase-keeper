import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Route-shaped loading states.
 *
 * These deliberately mirror the real layout rather than showing a generic spinner: the point
 * is that the page's structure — header, stat row, table — is already on screen when the data
 * lands, so the swap is a fill-in rather than a jump. A skeleton that doesn't match its page
 * is worse than none, because it moves everything the moment it resolves.
 *
 * One `role="status"` per route, on the outer wrapper, so a screen reader hears "Loading" once
 * instead of once per block.
 */

export function LoadingRegion({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Title, subtitle, and the action buttons that sit opposite them. */
export function PageHeaderSkeleton({ actions = 2 }: { actions?: number }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="grid gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="flex items-center gap-2">
        {Array.from({ length: actions }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-28" />
        ))}
      </div>
    </div>
  );
}

/** The six-tile counter row on the dashboard. */
export function StatRowSkeleton({ tiles = 6 }: { tiles?: number }) {
  return (
    <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {Array.from({ length: tiles }).map((_, i) => (
        <Card key={i} className="gap-1 py-3">
          <CardContent className="grid gap-1.5">
            <Skeleton className="h-6 w-10" />
            <Skeleton className="h-3 w-16" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * The project table.
 *
 * Row heights match the real ones (two stacked lines in most cells), which is what keeps the
 * page from shifting when the data arrives.
 */
export function ProjectTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Card className="overflow-hidden py-0">
      <div className="border-b px-4 py-3">
        <Skeleton className="h-9 w-full" />
      </div>
      <div className="divide-border divide-y">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[2fr_1.4fr_1fr_1fr_1.4fr_auto] items-center gap-4 px-4 py-4"
          >
            <div className="grid gap-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-24" />
            </div>
            <div className="grid gap-2">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-4 w-16 rounded-full" />
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
            <div className="grid gap-2">
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-3 w-20" />
            </div>
            <div className="hidden gap-2 md:grid">
              <Skeleton className="h-3.5 w-14" />
              <Skeleton className="h-3 w-28" />
            </div>
            <div className="flex justify-end gap-1">
              <Skeleton className="h-8 w-14" />
              <Skeleton className="size-8" />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** A stack of cards, for the accounts and vault pages. */
export function CardListSkeleton({ cards = 3, lines = 3 }: { cards?: number; lines?: number }) {
  return (
    <div className="grid gap-3">
      {Array.from({ length: cards }).map((_, i) => (
        <Card key={i}>
          <CardContent className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
            {Array.from({ length: lines }).map((_, j) => (
              <Skeleton key={j} className="h-3.5" style={{ width: `${88 - j * 17}%` }} />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** A form card: label/input pairs and a submit row. */
export function FormSkeleton({ fields = 5 }: { fields?: number }) {
  return (
    <Card>
      <CardContent className="grid gap-4">
        {Array.from({ length: fields }).map((_, i) => (
          <div key={i} className="grid gap-2">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
        <div className="flex gap-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-20" />
        </div>
      </CardContent>
    </Card>
  );
}
