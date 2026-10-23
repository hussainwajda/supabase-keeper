import { cn } from "@/lib/utils";

/**
 * A placeholder block, sized by the caller.
 *
 * `aria-hidden` throughout: a skeleton is a picture of content that isn't there yet, and
 * announcing it would read a screen full of nothing to a screen reader. The route-level
 * skeletons in `components/skeletons.tsx` carry one `role="status"` label between them, which
 * is the thing actually worth announcing.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      className={cn("bg-muted/70 animate-pulse rounded-md", className)}
      {...props}
    />
  );
}
