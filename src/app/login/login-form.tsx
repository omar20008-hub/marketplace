"use client";

import { useActionState, useState } from "react";
import { Button, Field, Input } from "@/components/ds";
import { login, type LoginState } from "@/server/auth-actions";
import { GoogleIcon } from "./google-icon";

export function LoginForm() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    login,
    {},
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <>
      <form action={formAction} className="mt-8 flex flex-col gap-4">
        <Field label="Email">
          <Input
            name="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="Password">
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        {state.error ? (
          <p className="text-[13px] text-danger-ink">{state.error}</p>
        ) : null}

        <Button type="submit" disabled={pending} className="mt-1 w-full">
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <div className="mt-6 flex items-center gap-3">
        <div className="flex-1 border-t border-selected" />
        <p className="text-xs text-ink-3">or</p>
        <div className="flex-1 border-t border-selected" />
      </div>

      <a
        href="/api/oauth/google/auth/start"
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-row border border-selected px-4 py-2.5 font-medium hover:bg-fill"
      >
        <GoogleIcon className="h-5 w-5" />
        Sign in with Google
      </a>

    </>
  );
}
