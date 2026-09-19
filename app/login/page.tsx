"use client";

import { useActionState } from "react";
import { login } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";

export default function LoginPage() {
  const [error, action] = useActionState(login, null);
  return (
    <div className="card login">
      <h1>Sign in</h1>
      <p className="muted small">Enter the APP_PASSWORD you set in your environment.</p>
      <form action={action} className="form">
        <input type="password" name="password" placeholder="Password" autoFocus required />
        {error && <div className="error">{error}</div>}
        <SubmitButton pending="Signing in…">Sign in</SubmitButton>
      </form>
    </div>
  );
}
