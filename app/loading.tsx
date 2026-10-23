import {
  LoadingRegion,
  PageHeaderSkeleton,
  ProjectTableSkeleton,
  StatRowSkeleton,
} from "@/components/skeletons";

/**
 * Shown the instant "Projects" is clicked, instead of the old page sitting there.
 *
 * The App Router needs a Suspense boundary to swap in while a dynamic route renders on the
 * server; without one it holds the previous screen and the click looks ignored. This file is
 * that boundary — and because it's static, the router can prefetch it, so the skeleton is
 * already in the client bundle when the navigation starts.
 */
export default function Loading() {
  return (
    <LoadingRegion label="Loading projects">
      <PageHeaderSkeleton />
      <StatRowSkeleton />
      <ProjectTableSkeleton rows={6} />
    </LoadingRegion>
  );
}
