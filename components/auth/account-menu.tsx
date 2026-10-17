"use client";

import { DownloadIcon, LogOutIcon, ShieldIcon } from "lucide-react";
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
            <button type="submit" className="flex w-full cursor-pointer items-center gap-2">
              <LogOutIcon aria-hidden />
              Sign out
            </button>
          </form>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
