"use client";

import { useActionState } from "react";
import { Check, Minus } from "lucide-react";
import { Button, FootNote, Input } from "@/components/ds";
import { connectMcpServer, type McpConnectState } from "@/server/mcp-actions";

/**
 * Connecting an MCP server: its name, its address and, if it asks for one, an access
 * token. The server is asked for its tools before anything is saved.
 */
export function McpForm({ allows }: { allows: { grants: string[]; denies: string[] } }) {
  const [state, formAction, pending] = useActionState<McpConnectState, FormData>(connectMcpServer, {});

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div>
        <div className="text-sm font-medium">MCP server</div>
        <div className="mt-2.5">
          <span className="text-xs text-ink-3">What this allows</span>
          <ul className="mt-1.5 flex flex-col gap-1.5 text-[13px]">
            {allows.grants.map((grant) => (
              <li key={grant} className="flex items-center gap-2">
                <Check size={14} strokeWidth={2} className="flex-none text-ready" />
                {grant}
              </li>
            ))}
            {allows.denies.map((deny) => (
              <li key={deny} className="flex items-center gap-2 text-ink-2">
                <Minus size={14} strokeWidth={2} className="flex-none text-ink-3" />
                {deny}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-selected pt-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Name</span>
          <Input name="name" defaultValue={state.values?.name} maxLength={40} placeholder="e.g. n8n" autoComplete="off" required />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Server address</span>
          <Input name="url" type="url" defaultValue={state.values?.url} placeholder="https://…" autoComplete="off" required />
          <span className="text-xs text-ink-3">An https address, without a token in it.</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Access token</span>
          <Input name="token" type="password" autoComplete="off" />
          <span className="text-xs text-ink-3">Leave empty only if the server needs none.</span>
        </label>
      </div>

      <FootNote>
        The token is kept encrypted and is never shown again. Agents and workflows reach the
        server through the platform, and never see the token.
      </FootNote>

      <div>
        <span className="text-xs text-ink-3">Use for</span>
        <div className="mt-1.5 flex gap-1.5">
          <label className="flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[13px] has-checked:border-ink has-checked:bg-ink has-checked:text-white">
            <input type="radio" name="reusable" value="one" className="sr-only" />
            Kept for me only
          </label>
          <label className="flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[13px] has-checked:border-ink has-checked:bg-ink has-checked:text-white">
            <input type="radio" name="reusable" value="all" defaultChecked className="sr-only" />
            My agents and workflows
          </label>
        </div>
        <span className="mt-1.5 block text-xs text-ink-3">
          A server kept for you only is not offered to agents and workflows.
        </span>
      </div>

      {state.error ? <p className="text-[13px] text-danger-ink">{state.error}</p> : null}
      {state.done ? <p className="text-[13px] text-ready-ink">{state.message ?? "Connected."}</p> : null}

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Checking the server…" : "Connect server"}
        </Button>
      </div>
    </form>
  );
}
