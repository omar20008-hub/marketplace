"use client";

import { useState } from "react";
import { Button } from "@/components/ds";

/**
 * Copies the export prompt for the person to run in their other assistant. If the
 * browser will not write to the clipboard, the text is still in the box to select by hand.
 */
export function CopyPrompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button type="button" size="sm" tone="secondary" onClick={copy}>
      {copied ? "Copied" : "Copy prompt"}
    </Button>
  );
}
