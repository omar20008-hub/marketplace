"use client";

import { useActionState, useState } from "react";
import { Button, Field, Input, Select } from "@/components/ds";
import { createUser, type CreateUserState } from "@/server/admin-actions";

const initialState: CreateUserState = {};

/**
 * The password is typed here, not generated — the admin is about to hand it
 * to someone over whatever channel they already use for that, and a masked
 * field would only make it harder to get right before sending it.
 *
 * The fields are controlled rather than left to defaultValue. React resets a
 * <form action={fn}> automatically once the action finishes — success or
 * error alike, since nothing distinguishes them at that level — which would
 * otherwise wipe a duplicate email the admin was about to fix along with the
 * name and password they had already typed correctly.
 */
export function CreateUserForm({ plans }: { plans: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState<CreateUserState, FormData>(
    createUser,
    initialState,
  );

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [planId, setPlanId] = useState(plans[0]?.id ?? "");

  // Cleared only on a genuine new success, tracked against the last one
  // already shown — an error afterward carries no createdEmail, so it can
  // never re-trigger this and clear what the admin is in the middle of
  // fixing. Adjusting state during render like this, rather than in an
  // effect, is the pattern for "reset state when a value changes."
  const [lastCreated, setLastCreated] = useState<string | undefined>(undefined);
  if (state.createdEmail && state.createdEmail !== lastCreated) {
    setLastCreated(state.createdEmail);
    setName("");
    setEmail("");
    setPassword("");
  }

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div className="w-40">
        <Field label="Name">
          <Input
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Jordan Lee"
          />
        </Field>
      </div>
      <div className="w-56">
        <Field label="Email">
          <Input
            name="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="jordan@example.com"
          />
        </Field>
      </div>
      <div className="w-44">
        <Field label="Password">
          <Input
            name="password"
            type="text"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="12+ characters"
          />
        </Field>
      </div>
      <div className="w-32">
        <Field label="Plan">
          <Select
            name="planId"
            value={planId}
            onChange={(event) => setPlanId(event.target.value)}
          >
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Button
        type="submit"
        tone="primary"
        size="sm"
        disabled={pending || plans.length === 0}
      >
        {pending ? "Creating…" : "Create account"}
      </Button>

      {state.error ? (
        <p className="w-full text-[13px] text-danger-ink">{state.error}</p>
      ) : null}
      {state.createdEmail ? (
        <p className="w-full text-[13px] text-ready-ink">
          Created {state.createdEmail}. Share the password with them yourself —
          this form does not keep it, and there is nowhere left to read it back
          from.
        </p>
      ) : null}
      {plans.length === 0 ? (
        <p className="w-full text-[13px] text-warn-ink">
          No plans exist yet, so there is nothing to put a new account on.
        </p>
      ) : null}
    </form>
  );
}
