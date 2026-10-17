"use client";

import { useActionState, useState } from "react";
import { signInWithGoogle, signInWithPassword, signUpWithPassword } from "@/app/auth/actions";
import { SubmitButton } from "@/components/buttons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";

/** Google's wordmark glyph. Inline so the button needs no network request to render. */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 18 18" className="size-4" aria-hidden focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86a5.36 5.36 0 0 1-5.03-3.71H1.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path fill="#FBBC05" d="M3.97 10.71A5.4 5.4 0 0 1 3.97 7.3V4.96H1.96a9 9 0 0 0 0 8.08l2.01-2.33Z" />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 1.96 4.96L3.97 7.3A5.36 5.36 0 0 1 9 3.58Z"
      />
    </svg>
  );
}

type Mode = "signin" | "signup";

export function LoginForm({
  next,
  initialError,
  googleEnabled,
}: {
  next: string;
  initialError: string | null;
  googleEnabled: boolean;
}) {
  const [mode, setMode] = useState<Mode>("signin");
  const [googleState, googleAction] = useActionState(signInWithGoogle, null);
  const [signInState, signInAction] = useActionState(signInWithPassword, null);
  const [signUpState, signUpAction] = useActionState(signUpWithPassword, null);

  const state = googleState ?? (mode === "signin" ? signInState : signUpState);
  // An error carried in the URL (an OAuth failure) survives until the next submit.
  const error = state?.error ?? (state ? null : initialError);
  const notice = state?.notice ?? null;

  return (
    <div className="grid gap-4">
      {googleEnabled && (
        <>
          <form action={googleAction}>
            <input type="hidden" name="next" value={next} />
            <SubmitButton variant="outline" className="w-full" pending="Redirecting…">
              <GoogleIcon />
              Continue with Google
            </SubmitButton>
          </form>

          <div className="flex items-center gap-3">
            <span className="bg-border h-px flex-1" />
            <span className="text-muted-foreground text-xs">or</span>
            <span className="bg-border h-px flex-1" />
          </div>
        </>
      )}

      <form action={mode === "signin" ? signInAction : signUpAction} className="grid gap-3">
        <input type="hidden" name="next" value={next} />

        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          hint={mode === "signup" ? "At least 8 characters." : undefined}
          error={error}
        >
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={mode === "signup" ? 8 : undefined}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
          />
        </Field>

        {notice && (
          <p role="status" className="text-accent text-[0.8125rem]">
            {notice}
          </p>
        )}

        <SubmitButton className="w-full" pending={mode === "signin" ? "Signing in…" : "Creating…"}>
          {mode === "signin" ? "Sign in" : "Create account"}
        </SubmitButton>
      </form>

      <p className="text-muted-foreground text-center text-xs">
        {mode === "signin" ? "No account yet?" : "Already have an account?"}{" "}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        >
          {mode === "signin" ? "Create one" : "Sign in"}
        </Button>
      </p>
    </div>
  );
}
