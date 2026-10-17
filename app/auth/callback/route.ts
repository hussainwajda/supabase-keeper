import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * OAuth / PKCE landing route. Supabase redirects here with a `code`, which we exchange for a
 * session. Configure this exact path as an allowed redirect URL in your Supabase project:
 *   http://localhost:3000/auth/callback   (local)
 *   https://<your-app>/auth/callback      (production)
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";
  const error = searchParams.get("error_description") ?? searchParams.get("error");

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent("No authorization code returned.")}`);
  }

  const supabase = await supabaseServer();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(exchangeError.message)}`);
  }

  // Only ever redirect to a path on this origin — never to a URL supplied in the query.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";

  // Behind a proxy, `origin` can be the internal host; honour the forwarded host in prod.
  const forwardedHost = request.headers.get("x-forwarded-host");
  const base =
    process.env.NODE_ENV === "development" || !forwardedHost
      ? origin
      : `https://${forwardedHost}`;

  return NextResponse.redirect(`${base}${safeNext}`);
}
