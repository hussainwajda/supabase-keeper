import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { usingNodeBackend } from "@/lib/backend/env";
import * as api from "@/lib/backend/api";

export const dynamic = "force-dynamic";

/** POST-only sign out, so a prefetch or an image tag can't log you out. */
export async function POST(request: NextRequest) {
  if (usingNodeBackend()) {
    // The API closes the vault before the session and clears both cookies; `apiPost` relays
    // those deletions onto this origin.
    await api.logout().catch(() => undefined);
  } else {
    const supabase = await supabaseServer();
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", request.nextUrl.origin));
}
