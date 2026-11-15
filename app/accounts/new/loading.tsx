import { LoadingRegion, PageHeaderSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <LoadingRegion label="Loading new account form">
      <PageHeaderSkeleton />
      <Skeleton className="h-[340px] max-w-3xl rounded-lg" />
    </LoadingRegion>
  );
}
