import { CardListSkeleton, LoadingRegion, PageHeaderSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <LoadingRegion label="Loading setup">
      <PageHeaderSkeleton actions={0} />
      <CardListSkeleton cards={3} lines={4} />
    </LoadingRegion>
  );
}
