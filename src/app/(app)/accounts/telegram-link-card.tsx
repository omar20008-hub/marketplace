"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, FootNote, SectionLabel } from "@/components/ds";
import { removeTelegramLink, startTelegramLink } from "@/server/channel-link-actions";

/**
 * Telegram is linked by proof, not by typing an id: the platform shows a code,
 * the person sends "/link <code>" to the bot from their own Telegram, and the
 * link is recorded only then. The code is shown here once and expires.
 */
export function TelegramLinkCard({
  linkedAt,
  botUsername,
}: {
  linkedAt: string | null;
  botUsername: string | null;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const generate = () => {
    setError(null);
    startTransition(async () => {
      const result = await startTelegramLink();
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
      await removeTelegramLink();
      setCode(null);
      setExpiresAt(null);
    });
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-10 flex-none items-center justify-center rounded-row bg-fill text-xs font-medium text-ink-2">
          TG
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Telegram</div>
          <div className="mt-0.5 text-xs text-ink-3">
            {linkedAt
              ? `Linked ${new Date(linkedAt).toLocaleDateString()}. Messages from that chat reach your assistant.`
              : "Not linked. Chat with your assistant from Telegram."}
          </div>
        </div>
        {linkedAt ? <Badge tone="ready">Linked</Badge> : <Badge tone="partial">Not linked</Badge>}
      </div>

      {linkedAt ? (
        <div>
          <Button tone="secondary" size="sm" onClick={unlink} disabled={pending}>
            Unlink Telegram
          </Button>
        </div>
      ) : code ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>Your code</SectionLabel>
          <div className="font-mono text-lg tracking-[0.2em] text-ink">{code}</div>
          <p className="text-[13px] text-ink-2">
            Open{" "}
            {botUsername ? (
              <a
                className="text-link-ink underline"
                href={`https://t.me/${botUsername}`}
                target="_blank"
                rel="noreferrer"
              >
                @{botUsername}
              </a>
            ) : (
              "the bot"
            )}{" "}
            in Telegram and send: <span className="font-mono">/link {code}</span>
          </p>
          {expiresAt ? (
            <FootNote>
              Valid until {new Date(expiresAt).toLocaleTimeString()}. It works once.
            </FootNote>
          ) : null}
          <div>
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
