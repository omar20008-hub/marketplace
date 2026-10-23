"use client";

import { useActionState, useState } from "react";
import { Button, Field, Input } from "@/components/ds";
import { login, type LoginState } from "@/server/auth-actions";
import Link from "next/link";
import { GoogleButton } from "./google-button";

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

      <GoogleButton label="Sign in with Google" />

      <p className="mt-6 text-center text-[13px] text-ink-2">
        New to Builder?{" "}
        <Link href="/signup" className="font-medium text-link-ink hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );
}
