import Link from "next/link";
import { DatabaseZapIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { LoginForm } from "@/components/auth/login-form";
import { usingNodeBackend } from "@/lib/backend/env";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  // Hidden on the Node backend: its Google flow sets a cookie on the API's own host, which
  // never reaches a browser that only talks to Next.js. See `signInWithGoogle`.
  const googleConfigured =
    process.env.KEEPSTACK_DISABLE_GOOGLE !== "true" && !usingNodeBackend();

  return (
    <div className="mx-auto mt-[10vh] max-w-sm">
      <div className="mb-5 grid gap-1.5 text-center">
        <DatabaseZapIcon className="text-accent mx-auto size-6" aria-hidden />
        <h1 className="text-lg font-semibold tracking-tight">Sign in to Keepstack</h1>
        <p className="text-muted-foreground text-[0.8125rem]">
          Every free-tier database you own, in one place.
        </p>
      </div>

      <Card>
        <CardContent>
          <LoginForm
            next={next ?? "/"}
            initialError={error ?? null}
            googleEnabled={googleConfigured}
          />
        </CardContent>
      </Card>

      <p className="text-muted-foreground mt-4 text-center text-xs">
        Keepstack stores credentials.{" "}
        <Link
          href="https://github.com/hussainwajda/keepstack/blob/main/docs/SECURITY.md"
          className="underline underline-offset-4"
          target="_blank"
          rel="noreferrer"
        >
          Read how they&apos;re protected
        </Link>{" "}
        — including the limits.
      </p>
    </div>
  );
}
