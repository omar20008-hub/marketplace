"use client";

import { useState } from "react";
import { Button } from "@/components/ds";
import { uninstall } from "@/server/install-actions";

/**
 * The real confirmation. The Uninstall workflow only checks that a free-text
 * field contains a word, so the dialog that actually protects the user has to
 * live here.
 */
export function UninstallButton({
  installationId,
  title,
}: {
  installationId: string;
  title: string;
}) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        className="text-[13px] text-ink-3 hover:text-danger-ink"
      >
        Remove
      </button>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2 rounded-card border border-danger-line bg-danger-wash p-3 sm:w-auto sm:flex-row sm:items-center">
      <p className="text-[13px] text-ink-2">
        Remove <span className="font-medium text-ink">{title}</span>? Its
        connections are deleted. Files it produced are kept.
      </p>
      <div className="flex gap-2">
        <Button type="button" tone="secondary" size="sm" onClick={() => setAsking(false)}>
          Cancel
        </Button>
        <form action={uninstall}>
          <input type="hidden" name="installationId" value={installationId} />
          <input type="hidden" name="confirmed" value="yes" />
          <Button type="submit" tone="danger" size="sm">
            Remove
          </Button>
        </form>
      </div>
    </div>
  );
}
