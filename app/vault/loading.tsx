import { CardListSkeleton, LoadingRegion, PageHeaderSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <LoadingRegion label="Loading vault">
      <PageHeaderSkeleton actions={1} />
      <CardListSkeleton cards={3} lines={2} />
    </LoadingRegion>
  );
}
