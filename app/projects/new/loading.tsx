import { FormSkeleton, LoadingRegion, PageHeaderSkeleton } from "@/components/skeletons";

export default function Loading() {
  return (
    <LoadingRegion label="Loading new project form">
      <PageHeaderSkeleton actions={0} />
      <FormSkeleton fields={6} />
    </LoadingRegion>
  );
}
