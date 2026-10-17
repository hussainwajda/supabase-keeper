"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, Loader2Icon } from "lucide-react";
import { reveal, type RevealState } from "@/app/vault/actions";
import { Button } from "@/components/ui/button";

/** Seconds a revealed value stays on screen before it re-masks itself. */
const REMASK_AFTER = 30;
/** Seconds after a copy before the clipboard is overwritten. */
const CLIPBOARD_CLEAR_AFTER = 60;

export function RevealField({
  secretId,
  label,
  disabled,
  disabledReason,
}: {
  secretId: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [state, action, pending] = useActionState(reveal, null);
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const value = state?.secretId === secretId ? state.value : null;

  // Re-mask on a timer. A revealed credential left on a shared or recorded screen is the
  // likeliest way one leaks, so this is not optional and not configurable.
  useEffect(() => {
    if (!value) return;
    setVisible(true);
    setCountdown(REMASK_AFTER);

    const tick = setInterval(() => {
      setCountdown((n) => {
        if (n <= 1) {
          setVisible(false);
          clearInterval(tick);
          return 0;
        }
        return n - 1;
      });
    }, 1000);

    return () => clearInterval(tick);
  }, [value]);

  // Clear the clipboard after a minute, and on unmount, so a revealed secret doesn't sit in
  // the paste buffer for the rest of the day.
  useEffect(() => {
    return () => {
      if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    };
  }, []);

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);

      if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
      clipboardTimer.current = setTimeout(() => {
        // Best-effort: some browsers refuse a clipboard write without a user gesture.
        navigator.clipboard.writeText("").catch(() => {});
      }, CLIPBOARD_CLEAR_AFTER * 1000);
    } catch {
      // Clipboard denied; the value is on screen and can be selected manually.
    }
  }

  if (disabled) {
    return (
      <p className="text-muted-foreground text-xs">
        {disabledReason ?? "Unlock the vault to reveal this."}
      </p>
    );
  }

  if (!value) {
    return (
      <form action={action} className="grid gap-1">
        <input type="hidden" name="secret_id" value={secretId} />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? <Loader2Icon className="animate-spin" aria-hidden /> : <EyeIcon aria-hidden />}
          {pending ? "Decrypting…" : `Reveal ${label}`}
        </Button>
        {state?.error && state.secretId === secretId && (
          <p role="alert" className="text-destructive text-xs">
            {state.error}
          </p>
        )}
      </form>
    );
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1.5">
        <code
          className="bg-muted min-w-0 flex-1 overflow-x-auto rounded-md px-2 py-1.5 font-mono text-xs"
          // Announce politely rather than assertively: this interrupts nothing.
          aria-live="polite"
        >
          {visible ? value : "•".repeat(Math.min(32, value.length))}
        </code>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide value" : "Show value"}
          title={visible ? "Hide" : "Show"}
        >
          {visible ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={copy}
          aria-label={`Copy ${label}`}
          title="Copy"
        >
          {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        </Button>
      </div>

      <p className="text-muted-foreground text-xs" role="status">
        {visible && countdown > 0 && `Hides in ${countdown}s. `}
        {!visible && "Hidden. "}
        {copied && `Copied — the clipboard clears in ${CLIPBOARD_CLEAR_AFTER}s.`}
      </p>
    </div>
  );
}
