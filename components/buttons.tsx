"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { CheckIcon, CopyIcon, Loader2Icon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import type { VariantProps } from "class-variance-authority";

type SubmitProps = {
  children: React.ReactNode;
  pending?: string;
  confirm?: string;
  className?: string;
} & VariantProps<typeof buttonVariants>;

export function SubmitButton({ children, pending, confirm, className, variant, size }: SubmitProps) {
  const status = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      className={className}
      disabled={status.pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {/* Loading feedback on every submit — never a click with no response. */}
      {status.pending && <Loader2Icon className="animate-spin" aria-hidden />}
      {status.pending ? (pending ?? "Working…") : children}
    </Button>
  );
}

export function CopyButton({
  text,
  label = "Copy",
  size = "icon-sm",
  variant = "ghost",
}: {
  text: string;
  label?: string;
  size?: VariantProps<typeof buttonVariants>["size"];
  variant?: VariantProps<typeof buttonVariants>["variant"];
}) {
  const [copied, setCopied] = React.useState(false);
  const iconOnly = size === "icon" || size === "icon-sm";

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={copy}
      // An icon-only button still needs an accessible name.
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
    >
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      {!iconOnly && (copied ? "Copied" : label)}
      {iconOnly && <span className="sr-only" role="status">{copied ? "Copied" : ""}</span>}
    </Button>
  );
}
