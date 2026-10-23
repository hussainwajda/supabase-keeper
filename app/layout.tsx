import type { Metadata } from "next";
import Link from "next/link";
import { Fira_Code, Fira_Sans } from "next/font/google";
import { DatabaseZapIcon, PlusIcon } from "lucide-react";
import { currentUser } from "@/lib/backend/user";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { AccountMenu } from "@/components/auth/account-menu";
import { Toaster } from "@/components/ui/sonner";
import { FlashToaster } from "@/components/flash-toaster";
import { RouteProgress } from "@/components/route-progress";
import { readFlash } from "@/lib/flash-server";
import { Suspense } from "react";
import "./globals.css";

const firaSans = Fira_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-fira-sans",
  display: "swap",
});

const firaCode = Fira_Code({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-fira-code",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Keepstack",
  description:
    "One home for every free-tier database you own — across every account and every provider. Tracks which account owns what, and keeps free projects from pausing.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Both are needed on every page, and neither depends on the other.
  const [user, flash] = await Promise.all([currentUser(), readFlash()]);

  return (
    <html lang="en" className={`${firaSans.variable} ${firaCode.variable}`} suppressHydrationWarning>
      <body>
        {/* `useSearchParams` inside RouteProgress needs a boundary, or every page opts
            out of static rendering to satisfy it. */}
        <Suspense fallback={null}>
          <RouteProgress />
        </Suspense>
        <TooltipProvider>
          <header className="bg-card/95 supports-[backdrop-filter]:bg-card/80 sticky top-0 z-30 border-b backdrop-blur">
            <div className="mx-auto flex h-14 max-w-[1240px] flex-wrap items-center justify-between gap-3 px-4">
              <Link
                href="/"
                className="flex items-center gap-2 font-semibold tracking-tight transition-opacity hover:opacity-80"
              >
                <DatabaseZapIcon className="text-accent size-4.5" aria-hidden />
                Keepstack
              </Link>

              {user && (
                <nav className="flex items-center gap-1" aria-label="Main">
                  <Button asChild variant="ghost" size="sm">
                    <Link href="/">Projects</Link>
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <Link href="/accounts">Accounts</Link>
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <Link href="/vault">Vault</Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link href="/projects/new">
                      <PlusIcon aria-hidden />
                      Project
                    </Link>
                  </Button>
                  <AccountMenu
                    email={user.email ?? "signed in"}
                    name={user.displayName}
                    avatarUrl={user.avatarUrl}
                  />
                </nav>
              )}
            </div>
          </header>

          <main className="mx-auto max-w-[1240px] px-4 py-6 pb-16">{children}</main>
        </TooltipProvider>
        <Toaster />
        <FlashToaster flash={flash} />
      </body>
    </html>
  );
}
