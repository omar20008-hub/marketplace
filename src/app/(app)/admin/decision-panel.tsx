"use client";

import { useActionState, useState } from "react";
import { Button, Field, Textarea } from "@/components/ds";
import {
  approve,
  reject,
  requestChanges,
  type DecisionState,
} from "@/server/admin-actions";

/**
 * A reason is required before any of the three buttons will submit, because
 * every decision goes to the audit log with the reviewer's name against it.
 *
 * Approve and Reject each publish or reject the template inside n8n before
 * touching this platform's own record of the decision, so — unlike every other
 * refusal in admin-actions.ts — a failure here is not a silent no-op: it is
 * surfaced, since it can be n8n itself refusing (e.g. the durability rule)
 * rather than a mistake the reviewer made.
 */
export function DecisionPanel({
  submissionId,
  hasBlocker,
}: {
  submissionId: string;
  hasBlocker: boolean;
}) {
  const [reason, setReason] = useState("");
  const ready = reason.trim().length > 0;

  const [approveState, approveAction, approvePending] = useActionState<
    DecisionState,
    FormData
  >(approve, {});
  const [rejectState, rejectAction, rejectPending] = useActionState<
    DecisionState,
    FormData
  >(reject, {});

  return (
    <form className="flex flex-col gap-3">
      <input type="hidden" name="submissionId" value={submissionId} />

      <Field label="Reason" required>
        <Textarea
          name="reason"
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Tell the creator exactly what to change…"
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          formAction={requestChanges}
          tone={ready ? "secondary" : "quiet"}
          size="sm"
          disabled={!ready}
        >
          Request changes
        </Button>
        <Button
          type="submit"
          formAction={approveAction}
          tone={ready && !hasBlocker ? "primary" : "quiet"}
          size="sm"
          disabled={!ready || hasBlocker || approvePending}
          title={
            hasBlocker
              ? "A blocker has to be fixed by the creator; it cannot be approved through."
              : undefined
          }
        >
          {approvePending ? "Publishing…" : "Approve & publish"}
        </Button>
        <Button
          type="submit"
          formAction={rejectAction}
          tone={ready ? "danger" : "quiet"}
          size="sm"
          disabled={!ready || rejectPending}
        >
          {rejectPending ? "Rejecting…" : "Reject"}
        </Button>
      </div>

      {approveState.error ? (
        <p className="text-[13px] text-danger-ink">{approveState.error}</p>
      ) : null}
      {rejectState.error ? (
        <p className="text-[13px] text-danger-ink">{rejectState.error}</p>
      ) : null}
    </form>
  );
}
