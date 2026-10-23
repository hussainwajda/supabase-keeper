"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { FLASH_COOKIE, type Flash } from "@/lib/flash";

/**
 * Fires the flash cookie as a toast, once, then deletes it.
 *
 * The delete has to happen here rather than on the server: a Server Component can read a
 * cookie during render but not write one, so without this the message would re-fire on every
 * navigation until it expired.
 *
 * Two things keep it to exactly one toast. The effect depends only on the message's own
 * fields, never on the `flash` object — that object is rebuilt by every server render, so
 * depending on it would re-fire the toast on renders where nothing actually changed. And a
 * ref holds the last key shown, because StrictMode invokes effects twice in development and
 * clearing the cookie doesn't change the prop that triggered them.
 */
export function FlashToaster({ flash }: { flash: Flash | null }) {
  const message = flash?.message;
  const tone = flash?.tone;
  const description = flash?.description;
  const lastShown = useRef<string | null>(null);

  useEffect(() => {
    if (!message) return;

    const key = `${tone}:${message}:${description ?? ""}`;
    if (lastShown.current === key) return;
    lastShown.current = key;

    document.cookie = `${FLASH_COOKIE}=; path=/; max-age=0; SameSite=Lax`;

    const show =
      tone === "error" ? toast.error : tone === "info" ? toast.info : toast.success;
    show(message, description ? { description } : undefined);
  }, [message, tone, description]);

  return null;
}
