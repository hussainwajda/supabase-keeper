import { NextResponse, type NextRequest } from "next/server";

/**
 * Route gating when the Node backend is active.
 *
 * Much thinner than its Supabase counterpart, and the difference is instructive. That one has
 * to call `supabase.auth.getUser()` on every request so an expiring access token gets
 * refreshed, then copy the resulting cookies onto whatever response is returned — including
 * redirects, which is the subtle part it spends most of its length on. Opaque server-side
 * sessions have no token to refresh, so none of that machinery has a counterpart here.
 *
 * What's left is a **presence check**, and it is important to be clear that this is routing,
 * not authorization. A cookie being present means "send this person to the app rather than the
 * sign-in page"; whether the session is real is decided by the API, which looks the token hash
 * up and compares the expiry on every call. Someone who forges a `ks_session` cookie gets past
 * this redirect and then gets a 401 from the first data call, which is the correct outcome.
 *
 * The alternative — validating against the API here — would add a network round trip to every
 * request including static page loads, to produce a nicer redirect for a case that only
 * happens when a session expires between page loads.
 */
const SESSION_COOKIE = "ks_session";

/** Paths reachable without a session. */
const PUBLIC_PREFIXES = ["/login", "/auth", "/api/cron", "/setup"];

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function gateNodeBackend(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const signedIn = !!request.cookies.get(SESSION_COOKIE)?.value;
  const isPublic = matchesPrefix(pathname, PUBLIC_PREFIXES);

  if (!signedIn && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Send them back where they were trying to go, once they're signed in.
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (signedIn && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request });
}
