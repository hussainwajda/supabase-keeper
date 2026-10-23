import { CardListSkeleton, LoadingRegion, PageHeaderSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <LoadingRegion label="Loading accounts">
      <PageHeaderSkeleton actions={1} />
      <CardListSkeleton cards={4} />
    </LoadingRegion>
  );
}
