"use client";

import { useEffect } from "react";
import { Button, ButtonLink, Card, FootNote, Mono } from "@/components/ds";

/**
 * What a screen shows when it throws.
 *
 * Without this, Next's own error page appears: a stack trace in development, a
 * bare "Application error" in production. Neither tells someone what to do, and
 * the second one looks like the whole product is broken rather than one page.
 *
 * The digest is shown deliberately. It is the only thing that ties what the
 * person saw to the line in the server log, and it carries no detail of its own
 * — the message itself is kept server-side by Next, which is the right place
 * for it.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Goes to the server log in production, and to the browser console in
    // development, where it is the fastest thing to read.
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-full items-center justify-center px-5 py-16">
      <Card className="flex w-full max-w-[520px] flex-col gap-4 p-6">
        <div>
          <h1 className="text-base font-medium">This screen did not load</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
            Something failed on our side, not yours. Nothing you were doing was
            saved, so trying again is safe.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={reset}>
            Try again
          </Button>
          <ButtonLink href="/" tone="secondary" size="sm">
            Back to start
          </ButtonLink>
        </div>

        {error.digest ? (
          <div className="border-t border-selected pt-3">
            <FootNote>
              If you report this, quote the reference — it is how the failure is
              found in the log.
            </FootNote>
            <Mono className="mt-1 text-[11.5px] text-ink-3">
              reference {error.digest}
            </Mono>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
