"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({
  children,
  pending,
  className = "btn",
  confirm,
}: {
  children: React.ReactNode;
  pending?: string;
  className?: string;
  confirm?: string;
}) {
  const status = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={status.pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {status.pending ? (pending ?? "Working…") : children}
    </button>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={async (e) => {
        const el = e.currentTarget;
        await navigator.clipboard.writeText(text);
        el.textContent = "Copied";
        setTimeout(() => (el.textContent = label), 1200);
      }}
    >
      {label}
    </button>
  );
}
