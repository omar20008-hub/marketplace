"use client";

import { useState } from "react";
import { Button, Field, Textarea } from "@/components/ds";
import { approve, reject, requestChanges } from "@/server/admin-actions";

/**
 * A reason is required before any of the three buttons will submit, because
 * every decision goes to the audit log with the reviewer's name against it.
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
          formAction={approve}
          tone={ready && !hasBlocker ? "primary" : "quiet"}
          size="sm"
          disabled={!ready || hasBlocker}
          title={
            hasBlocker
              ? "A blocker has to be fixed by the creator; it cannot be approved through."
              : undefined
          }
        >
          Approve &amp; publish
        </Button>
        <Button
          type="submit"
          formAction={reject}
          tone={ready ? "danger" : "quiet"}
          size="sm"
          disabled={!ready}
        >
          Reject
        </Button>
      </div>
    </form>
  );
}
