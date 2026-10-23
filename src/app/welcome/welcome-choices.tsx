"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, ButtonAnchor, ButtonLink, Card, FootNote } from "@/components/ds";
import { whatsappChatUrl, whatsappLinkMessage } from "@/lib/onboarding";
import { startWhatsappLink, whatsappLinked } from "@/server/channel-link-actions";

const POLL_MS = 3000;

/**
 * The two ways on. "Activate WhatsApp" issues a link code and opens a WhatsApp
 * chat with the business number, "/link <code>" already typed: the person only
 * presses send. The page then watches for the link to go through.
 */
export function WelcomeChoices({
  businessNumber,
  linked: linkedAtStart,
}: {
  businessNumber: string | null;
  linked: boolean;
}) {
  const [linked, setLinked] = useState(linkedAtStart);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const chatUrl = whatsappChatUrl(businessNumber);
  const linkUrl = code ? whatsappChatUrl(businessNumber, whatsappLinkMessage(code)) : null;

  // While a code is out, ask every few seconds whether it has been sent.
  useEffect(() => {
    if (!code || linked) return;
    const timer = setInterval(async () => {
      if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
        clearInterval(timer);
        return;
      }
      try {
        if (await whatsappLinked()) setLinked(true);
      } catch {
        // A dropped request; the next tick asks again.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [code, expiresAt, linked]);

  const activate = () => {
    setError(null);
    // Opened inside the click, so a popup blocker lets it through; it is
    // pointed at WhatsApp once the code is back.
    const tab = window.open("", "_blank");
    startTransition(async () => {
      const result = await startWhatsappLink();
      if (result.error || !result.code) {
        tab?.close();
        setError(result.error ?? "Could not start WhatsApp. Try again.");
        return;
      }
      setCode(result.code);
      setExpiresAt(result.expiresAt ?? null);
      const url = whatsappChatUrl(businessNumber, whatsappLinkMessage(result.code));
      if (!url) return;
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.assign(url);
      }
    });
  };

  if (linked) {
    return (
      <Card className="mt-8 flex flex-col gap-3 p-4">
        <div className="text-sm font-medium">WhatsApp is linked</div>
        <p className="text-[13px] text-ink-2">
          Messages from your WhatsApp now reach your assistant. Carry on there, or here.
        </p>
        <div className="flex flex-wrap gap-2">
          {chatUrl ? (
            <ButtonAnchor href={chatUrl} target="_blank" rel="noopener noreferrer" size="sm">
              Open WhatsApp
            </ButtonAnchor>
          ) : null}
          <ButtonLink href="/" tone="secondary" size="sm">
            Continue in Builder
          </ButtonLink>
        </div>
      </Card>
    );
  }

  return (
    <div className="mt-8 flex flex-col gap-3">
      <Card className="flex flex-col gap-3 p-4">
        <div>
          <div className="text-sm font-medium">Chat on WhatsApp</div>
          <p className="mt-1 text-[13px] text-ink-2">
            We open WhatsApp with your activation code already typed. Send it, and your
            assistant answers you there.
          </p>
        </div>

        {!chatUrl ? (
          <FootNote>WhatsApp is not set up on this server yet.</FootNote>
        ) : code && linkUrl ? (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-ink-2">
              In WhatsApp, press send on{" "}
              <span className="font-mono text-ink">{whatsappLinkMessage(code)}</span>. This page
              updates once it arrives.
            </p>
            {expiresAt ? (
              <FootNote>
                The code works once, until {new Date(expiresAt).toLocaleTimeString()}.
              </FootNote>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <ButtonAnchor href={linkUrl} target="_blank" rel="noopener noreferrer" size="sm">
                Open WhatsApp again
              </ButtonAnchor>
              <Button tone="secondary" size="sm" onClick={activate} disabled={pending}>
                New code
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button size="sm" onClick={activate} disabled={pending}>
              {pending ? "Opening WhatsApp…" : "Activate WhatsApp"}
            </Button>
          </div>
        )}

        {error ? (
          <p role="alert" className="text-[13px] text-danger-ink">
            {error}
          </p>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <div>
          <div className="text-sm font-medium">Chat here in Builder</div>
          <p className="mt-1 text-[13px] text-ink-2">
            Talk to your assistant in the browser. You can link WhatsApp later from Accounts.
          </p>
        </div>
        <div>
          <ButtonLink href="/" tone="secondary" size="sm">
            Continue in Builder
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}
