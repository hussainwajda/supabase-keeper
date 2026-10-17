import type { Metadata } from "next";
import Link from "next/link";
import { Fira_Code, Fira_Sans } from "next/font/google";
import { cookies } from "next/headers";
import { DatabaseZapIcon, PlusIcon } from "lucide-react";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { logout } from "@/app/actions";
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
  const authed = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);

  return (
    <html lang="en" className={`${firaSans.variable} ${firaCode.variable}`} suppressHydrationWarning>
      <body>
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

              {authed && (
                <nav className="flex items-center gap-1" aria-label="Main">
                  <Button asChild variant="ghost" size="sm">
                    <Link href="/">Projects</Link>
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <Link href="/accounts">Accounts</Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link href="/projects/new">
                      <PlusIcon aria-hidden />
                      Project
                    </Link>
                  </Button>
                  <form action={logout} className="ml-1">
                    <Button variant="ghost" size="sm" type="submit">
                      Log out
                    </Button>
                  </form>
                </nav>
              )}
            </div>
          </header>

          <main className="mx-auto max-w-[1240px] px-4 py-6 pb-16">{children}</main>
        </TooltipProvider>
      </body>
    </html>
  );
}
