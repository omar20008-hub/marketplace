"use client";

import { useActionState, useState } from "react";
import { Button, Field, FootNote, Input } from "@/components/ds";
import { login, type LoginState } from "@/server/auth-actions";

// Seeded accounts. Two roles, so every screen is reachable without a signup flow
// the design has not been drawn yet.
const DEMO = [
  { email: "nora@acme.co", who: "Nora Haddad — user and admin" },
  { email: "rami@studio.co", who: "Rami K. — creator" },
];

export function LoginForm() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    login,
    {},
  );
  const [email, setEmail] = useState(DEMO[0].email);
  const [password, setPassword] = useState("builder");

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

      <div className="mt-8 rounded-card border border-selected p-4">
        <p className="text-[13px] font-medium">Seeded accounts</p>
        <div className="mt-3 flex flex-col gap-2">
          {DEMO.map((account) => (
            <button
              key={account.email}
              type="button"
              onClick={() => {
                setEmail(account.email);
                setPassword("builder");
              }}
              className="flex flex-col rounded-row px-2.5 py-2 text-left hover:bg-fill"
            >
              <span className="font-mono text-xs text-ink-2">{account.email}</span>
              <span className="text-xs text-ink-3">{account.who}</span>
            </button>
          ))}
        </div>
        <FootNote>Password for both is `builder`.</FootNote>
      </div>
    </>
  );
}
