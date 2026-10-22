"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button, Field, Input } from "@/components/ds";
import { signup, type SignupState } from "@/server/auth-actions";
import { GoogleButton } from "../login/google-button";

export function SignupForm({ minPasswordLength }: { minPasswordLength: number }) {
  const [state, formAction, pending] = useActionState<SignupState, FormData>(signup, {});
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <>
      <form action={formAction} className="mt-8 flex flex-col gap-4">
        <Field label="Name">
          <Input
            name="name"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Email">
          <Input
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="Password" hint={`At least ${minPasswordLength} characters.`}>
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        {state.error ? <p className="text-[13px] text-danger-ink">{state.error}</p> : null}

        <Button type="submit" disabled={pending} className="mt-1 w-full">
          {pending ? "Creating your account…" : "Create account"}
        </Button>
      </form>

      <GoogleButton label="Sign up with Google" />

      <p className="mt-6 text-center text-[13px] text-ink-2">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-link-ink hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
