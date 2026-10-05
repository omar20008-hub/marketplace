"use client";

import type { TextareaHTMLAttributes } from "react";
import { useFormStatus } from "react-dom";

/**
 * Pending feedback for a form whose action is async. These read useFormStatus,
 * which flips the moment the form submits. State set inside the action itself
 * does not: React holds it back until the action finishes, so a `busy` flag
 * shown from there would only appear when the reply had already arrived.
 */

export function PendingNote({ className }: { className?: string }) {
  const { pending } = useFormStatus();
  return pending ? (
    <span role="status" className={className}>
      Thinking…
    </span>
  ) : null;
}

export function PendingTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { pending } = useFormStatus();
  return <textarea {...props} readOnly={pending || props.readOnly} />;
}
