"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, FootNote, SectionLabel } from "@/components/ds";
import { removeAgentKey, startAgentKey } from "@/server/agent-key-actions";

/**
 * The key that lets your personal assistant act for you on the platform. It is
 * shown once: paste it into the assistant's own settings and keep it private.
 * Creating a new key cuts off the old one.
 */
export function AgentKeyCard({ active }: { active: boolean }) {
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(active);
  const [pending, startTransition] = useTransition();

  const generate = () => {
    setError(null);
    startTransition(async () => {
      const result = await startAgentKey();
      if (result.error) {
        setError(result.error);
        return;
      }
      setKey(result.key ?? null);
      setIsActive(true);
    });
  };

  const revoke = () => {
    setError(null);
    startTransition(async () => {
      await removeAgentKey();
      setKey(null);
      setIsActive(false);
    });
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-10 flex-none items-center justify-center rounded-row bg-fill text-xs font-medium text-ink-2">
          AI
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Personal assistant key</div>
          <div className="mt-0.5 text-xs text-ink-3">
            {isActive
              ? "Your assistant can act for you on the platform with this key."
              : "No key yet. Create one so your personal assistant can reach your data."}
          </div>
        </div>
        {isActive ? <Badge tone="ready">Active</Badge> : <Badge tone="partial">None</Badge>}
      </div>

      {key ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>Your key</SectionLabel>
          <div className="break-all font-mono text-[13px] text-ink">{key}</div>
          <FootNote>Copy it now. It is shown once and cannot be displayed again.</FootNote>
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button size="sm" onClick={generate} disabled={pending}>
          {isActive ? "Replace key" : "Create key"}
        </Button>
        {isActive ? (
          <Button tone="secondary" size="sm" onClick={revoke} disabled={pending}>
            Revoke
          </Button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-[13px] text-danger-ink">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
