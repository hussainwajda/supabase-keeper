import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { registryAnonKey, registryConfigured, registryUrl } from "./env";

/** Paths reachable without a session. */
const PUBLIC_PREFIXES = ["/login", "/auth", "/api/cron", "/setup"];

/**
 * Paths that must work even when the registry env is incomplete.
 *
 * The cron authenticates with its own shared secret and talks to the database through the
 * service role, so it needs neither a user session nor the anon key. Gating it behind the
 * setup screen would silently stop every keep-alive on a deployment that is missing only the
 * anon key — the app would look half-broken while quietly letting projects pause.
 */
const CONFIG_EXEMPT_PREFIXES = ["/api/cron", "/setup"];

function matchesPrefix(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isPublic(pathname: string): boolean {
  return matchesPrefix(pathname, PUBLIC_PREFIXES);
}

/**
 * Refresh the Supabase session on every request and gate the private routes.
 *
 * The cookie dance matters: `supabase.auth.getUser()` may issue a refreshed token, and those
 * cookies have to be written onto the response that is actually returned — including the
 * redirect. Copying them onto the redirect is what stops a signed-in user from being bounced
 * to /login the moment their access token expires.
 */
export async function updateSession(request: NextRequest) {
  // Without the registry env there is no auth to check, so send browsers to the setup page
  // rather than throwing on every request — but let the exempt paths through untouched.
  if (!registryConfigured()) {
    if (matchesPrefix(request.nextUrl.pathname, CONFIG_EXEMPT_PREFIXES)) {
      return NextResponse.next({ request });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/setup";
    url.search = "";
    return NextResponse.redirect(url);
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(registryUrl(), registryAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublic(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Send the user back where they were trying to go, once they're signed in.
    if (pathname !== "/") url.searchParams.set("next", pathname);
    const redirect = NextResponse.redirect(url);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    const redirect = NextResponse.redirect(url);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  return response;
}
