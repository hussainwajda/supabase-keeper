import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CardListSkeleton, LoadingRegion } from "@/components/skeletons";

/**
 * The detail page is the slowest route — it fans out to the project, its account, the ping
 * log and the vault — so it is the one where a dead click was most obvious.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading project">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-52" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-28" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="grid gap-4">
          <Card>
            <CardContent className="grid gap-4">
              <Skeleton className="h-5 w-36" />
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="grid gap-2">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ))}
              <Skeleton className="h-9 w-32" />
            </CardContent>
          </Card>
          <CardListSkeleton cards={1} lines={5} />
        </div>

        <div className="grid gap-4">
          <Card>
            <CardContent className="grid gap-3">
              <Skeleton className="h-5 w-28" />
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between gap-3">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-3.5 w-16" />
                </div>
              ))}
            </CardContent>
          </Card>
          <CardListSkeleton cards={1} lines={3} />
        </div>
      </div>
    </LoadingRegion>
  );
}
