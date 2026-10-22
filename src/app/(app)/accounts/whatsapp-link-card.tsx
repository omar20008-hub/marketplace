"use client";

import { useState, useTransition } from "react";
import { Badge, Button, ButtonAnchor, Card, FootNote, SectionLabel } from "@/components/ds";
import { whatsappChatUrl, whatsappLinkMessage } from "@/lib/onboarding";
import { removeWhatsappLink, startWhatsappLink } from "@/server/channel-link-actions";

/**
 * WhatsApp is linked by proof, not by typing a number: the platform shows a
 * code, the person sends "/link <code>" to the business number from their own
 * WhatsApp, and the link is recorded only then. The code is shown here once and expires.
 */
export function WhatsappLinkCard({
  linkedAt,
  businessNumber,
}: {
  linkedAt: string | null;
  businessNumber: string | null;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const linkUrl = code ? whatsappChatUrl(businessNumber, whatsappLinkMessage(code)) : null;

  const generate = () => {
    setError(null);
    startTransition(async () => {
      const result = await startWhatsappLink();
      if (result.error) {
        setError(result.error);
        return;
      }
      setCode(result.code ?? null);
      setExpiresAt(result.expiresAt ?? null);
    });
  };

  const unlink = () => {
    setError(null);
    startTransition(async () => {
      await removeWhatsappLink();
      setCode(null);
      setExpiresAt(null);
    });
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-10 flex-none items-center justify-center rounded-row bg-fill text-xs font-medium text-ink-2">
          WA
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">WhatsApp</div>
          <div className="mt-0.5 text-xs text-ink-3">
            {linkedAt
              ? `Linked ${new Date(linkedAt).toLocaleDateString()}. Messages from that chat reach your assistant.`
              : "Not linked. Chat with your assistant from WhatsApp."}
          </div>
        </div>
        {linkedAt ? <Badge tone="ready">Linked</Badge> : <Badge tone="partial">Not linked</Badge>}
      </div>

      {linkedAt ? (
        <div>
          <Button tone="secondary" size="sm" onClick={unlink} disabled={pending}>
            Unlink WhatsApp
          </Button>
        </div>
      ) : code ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>Your code</SectionLabel>
          <div className="font-mono text-lg tracking-[0.2em] text-ink">{code}</div>
          <p className="text-[13px] text-ink-2">
            Open WhatsApp and send to{" "}
            {businessNumber ? <span className="font-mono">{businessNumber}</span> : "the business number"}:{" "}
            <span className="font-mono">{whatsappLinkMessage(code)}</span>
          </p>
          {expiresAt ? (
            <FootNote>
              Valid until {new Date(expiresAt).toLocaleTimeString()}. It works once.
            </FootNote>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {linkUrl ? (
              <ButtonAnchor href={linkUrl} target="_blank" rel="noopener noreferrer" size="sm">
                Open WhatsApp
              </ButtonAnchor>
            ) : null}
            <Button tone="secondary" size="sm" onClick={generate} disabled={pending}>
              New code
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button size="sm" onClick={generate} disabled={pending}>
            Get a link code
          </Button>
        </div>
      )}

      {error ? (
        <p role="alert" className="text-[13px] text-danger-ink">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
