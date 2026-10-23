"use client";

import { Toaster as Sonner } from "sonner";

/**
 * Toasts, themed from the app's own tokens.
 *
 * `theme="system"` rather than a hardcoded value: `globals.css` defines the dark palette under
 * `prefers-color-scheme`, so the toast follows the same signal the rest of the page does.
 * Colours come through CSS variables so a toast can never drift from the card it covers.
 */
export function Toaster() {
  return (
    <Sonner
      theme="system"
      position="bottom-right"
      closeButton
      richColors={false}
      toastOptions={{
        classNames: {
          toast:
            "group bg-card text-card-foreground border border-border shadow-lg rounded-lg text-[0.8125rem]",
          description: "text-muted-foreground",
          actionButton: "bg-accent text-accent-foreground",
          cancelButton: "bg-muted text-muted-foreground",
          error: "border-destructive/40",
          success: "border-accent/40",
        },
      }}
      style={
        {
          "--normal-bg": "var(--card)",
          "--normal-text": "var(--card-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
    />
  );
}
