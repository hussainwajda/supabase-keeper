"use client";

import { useFormStatus } from "react-dom";
import { DownloadIcon, Loader2Icon, LogOutIcon, ShieldIcon } from "lucide-react";
import { signOut } from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AccountMenu({
  email,
  name,
  avatarUrl,
}: {
  email: string;
  name: string | null;
  avatarUrl: string | null;
}) {
  const initial = (name ?? email).trim().charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-1 rounded-full"
          aria-label={`Account menu for ${email}`}
        >
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- avatar host varies by OAuth provider
            <img src={avatarUrl} alt="" className="size-7 rounded-full object-cover" />
          ) : (
            <span className="bg-accent text-accent-foreground flex size-7 items-center justify-center rounded-full text-xs font-semibold">
              {initial}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="grid gap-0.5">
          {name && <span className="text-foreground">{name}</span>}
          <span className="text-muted-foreground font-normal break-all">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <a href="/api/export" download>
            <DownloadIcon aria-hidden />
            Export registry
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="/vault">
            <ShieldIcon aria-hidden />
            Vault
          </a>
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          {/* A form POST, so no prefetch or image request can sign you out. */}
          <form action={signOut}>
            <SignOutButton />
          </form>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Signing out hits the network, and the menu stays open while it does. Without this the item
 * looked inert for the whole round trip — the one place in the app a click had no feedback.
 *
 * Split into its own component because `useFormStatus` reads the nearest enclosing form, and
 * a hook called in `AccountMenu` itself would be outside it.
 */
function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex w-full cursor-pointer items-center gap-2 disabled:opacity-60"
    >
      {pending ? <Loader2Icon className="animate-spin" aria-hidden /> : <LogOutIcon aria-hidden />}
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
