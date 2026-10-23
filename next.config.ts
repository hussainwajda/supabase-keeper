import type { NextConfig } from "next";

/**
 * Why this file exists: navigation felt dead for a second or two on every click.
 *
 * Every page here is `force-dynamic`, which is correct — this is a dashboard over live
 * registry data, and a cached project list is a wrong project list. But a dynamic route with
 * no Suspense boundary gives the App Router nothing to paint while the server renders, so the
 * browser sits on the *old* page until the RSC payload lands. The click looked ignored.
 *
 * The fix is mostly the `loading.tsx` files added alongside each route — those give the
 * router an instant boundary to swap in. This config handles the other half: how long an
 * already-fetched route stays usable in the client router cache.
 *
 * `staleTimes.dynamic` defaults to 0, meaning every visit to a dynamic route — including
 * going Back, or bouncing between Projects and Accounts — refetches from the server. Thirty
 * seconds makes those repeat navigations instant, which is the "React + Vite" feel. It is
 * safe here because every mutation already calls `revalidatePath("/", "layout")`, and that
 * clears the client router cache too: a stale read can only happen if something changed the
 * data *outside* this tab, which for a personal registry is a 30-second window at worst.
 */
const nextConfig: NextConfig = {
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
};

export default nextConfig;
