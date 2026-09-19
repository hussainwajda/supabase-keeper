import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { logout } from "@/app/actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "Supabase Keeper",
  description: "Track which Supabase account owns which project, and keep free projects from pausing.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const authed = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="logo">⚡</span> Supabase Keeper
          </Link>
          {authed && (
            <nav>
              <Link href="/">Projects</Link>
              <Link href="/accounts">Accounts</Link>
              <Link href="/projects/new" className="btn btn-sm">+ Project</Link>
              <form action={logout}>
                <button className="btn btn-ghost btn-sm">Log out</button>
              </form>
            </nav>
          )}
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
