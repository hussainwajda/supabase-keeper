import { redirect } from "next/navigation";
import { AlertTriangleIcon, CheckIcon } from "lucide-react";
import { missingRegistryEnv } from "@/lib/supabase/env";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

const WHERE: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL:
    "Supabase dashboard → your registry project → Project Settings → Data API → Project URL",
  NEXT_PUBLIC_SUPABASE_ANON_KEY:
    "Project Settings → API Keys → the anon / publishable key. NOT the service_role key.",
  SUPABASE_SERVICE_ROLE_KEY:
    "Project Settings → API Keys → service_role. Server-only — never prefix this with NEXT_PUBLIC_.",
};

export default function SetupPage() {
  const missing = missingRegistryEnv();
  // Once configured, this page would only tell an anonymous visitor about the deployment's
  // environment. There is nothing left to set up, so send them to the app.
  if (missing.length === 0) redirect("/");

  return (
    <div className="mx-auto mt-[8vh] max-w-xl">
      <div className="mb-5 grid gap-1.5">
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <AlertTriangleIcon className="text-warning size-5" aria-hidden />
          Keepstack isn&apos;t configured yet
        </h1>
        <p className="text-muted-foreground text-[0.8125rem]">
          Keepstack needs a Supabase project to store its own tables and to handle sign-in. Add
          the values below to <code className="font-mono">.env.local</code> (or your Vercel
          environment) and restart.
        </p>
      </div>

      <Card>
        <CardContent className="grid gap-3">
          {Object.keys(WHERE).map((key) => {
            const isMissing = missing.includes(key);
            return (
              <div key={key} className="grid gap-1 border-b pb-3 last:border-0 last:pb-0">
                <div className="flex items-center gap-2">
                  {isMissing ? (
                    <Badge variant="destructive">Missing</Badge>
                  ) : (
                    <Badge variant="success">
                      <CheckIcon aria-hidden />
                      Set
                    </Badge>
                  )}
                  <code className="font-mono text-[0.8125rem] break-all">{key}</code>
                </div>
                <p className="text-muted-foreground text-xs">{WHERE[key]}</p>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardContent className="grid gap-2">
          <h2 className="text-sm font-semibold">Then, in that project&apos;s SQL editor</h2>
          <p className="text-muted-foreground text-[0.8125rem]">
            Run the migrations in order from <code className="font-mono">supabase/migrations/</code>:
            <code className="font-mono"> 0001</code>, <code className="font-mono">0002</code>,{" "}
            <code className="font-mono">0003</code>. Sign in, claim any pre-existing rows, then
            run <code className="font-mono">0004</code>.
          </p>
          <h2 className="mt-2 text-sm font-semibold">And for the Google button</h2>
          <p className="text-muted-foreground text-[0.8125rem]">
            Authentication → Sign In / Providers → Google, with a client ID and secret from the
            Google Cloud console. Add{" "}
            <code className="font-mono">&lt;your-site&gt;/auth/callback</code> to the project&apos;s
            redirect allow-list. Until then, set{" "}
            <code className="font-mono">KEEPSTACK_DISABLE_GOOGLE=true</code> and use email +
            password.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
