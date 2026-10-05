"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Shown under a message that has no reply yet. The reply is produced on the server
 * after the message was stored, so this asks the page for fresh data every couple of
 * seconds until it arrives (the page stops rendering this once it has).
 */
export function AwaitingReply() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(timer);
  }, [router]);

  return (
    <p role="status" aria-live="polite" className="flex items-center gap-2 text-[15px] text-ink-3">
      <span className="inline-block size-2 animate-pulse rounded-full bg-ink-3" aria-hidden />
      Thinking…
    </p>
  );
}
