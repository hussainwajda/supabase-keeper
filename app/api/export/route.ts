import { NextResponse } from "next/server";
import { currentUser } from "@/lib/supabase/server";
import { exportRegistry } from "@/lib/registry";

export const dynamic = "force-dynamic";

/**
 * Full registry export — the safety net that exists before any risky migration.
 * Secrets are excluded by `exportRegistry()`, so the downloaded file is safe to keep on disk.
 */
export async function GET() {
  if (!(await currentUser())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await exportRegistry();
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="keepstack-export-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
