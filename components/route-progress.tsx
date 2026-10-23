"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * A thin progress bar across the top of the page while a navigation is in flight.
 *
 * The `loading.tsx` skeletons already answer "did my click register", but only once the new
 * route's boundary mounts. This covers the gap before that — and the navigations that have no
 * boundary of their own, like a `redirect()` out of a server action.
 *
 * It watches clicks rather than router internals on purpose. The App Router exposes no
 * "navigation started" event (`useLinkStatus` is per-`<Link>`, and wrapping every link in the
 * app to get a global bar is a worse trade), but a same-origin left-click on an anchor is
 * exactly the moment a navigation begins, and a change in pathname or query string is exactly
 * the moment it ends.
 */
export function RouteProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [progress, setProgress] = useState<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  useEffect(() => {
    function onClick(event: MouseEvent) {
      // Modified clicks open a new tab — the current page isn't going anywhere.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as HTMLElement | null)?.closest("a");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same page, or only a hash change: no render, so no bar.
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }

      clearTimers();
      setProgress(8);
      // Creep toward 90% so the bar is always moving. It never reaches the end on its own —
      // only the arrival of the new route finishes it.
      timers.current.push(setTimeout(() => setProgress(45), 90));
      timers.current.push(setTimeout(() => setProgress(72), 280));
      timers.current.push(setTimeout(() => setProgress(90), 700));
    }

    document.addEventListener("click", onClick, { capture: true });
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      clearTimers();
    };
  }, []);

  // The route changed: snap to full, then fade out.
  useEffect(() => {
    clearTimers();
    setProgress((current) => (current === null ? null : 100));
    const done = setTimeout(() => setProgress(null), 280);
    return () => clearTimeout(done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5"
      data-active={progress !== null}
    >
      <div
        className="bg-accent h-full origin-left shadow-[0_0_8px_var(--accent)] transition-[width,opacity] duration-200 ease-out"
        style={{
          width: `${progress ?? 0}%`,
          opacity: progress === null || progress === 100 ? 0 : 1,
        }}
      />
    </div>
  );
}
