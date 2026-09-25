"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowUp, Sparkles } from "lucide-react";

type Message = { role: "USER" | "ASSISTANT"; body: string };

function randomId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/**
 * The composer for someone with no account. Same look as Composer, same
 * Orchestrator on the other end (via /api/guest/chat, not a Server Action —
 * there is no Thread to attach one to), but everything lives in this
 * component's own state rather than a database row: no "Pick a product"
 * (a guest owns nothing to pick), no Schedule link (nowhere for it to lead),
 * and no redirect to /tasks/[id] — the exchange stays on this page and is
 * gone the moment it is.
 */
export function GuestChat({
  className,
  suggestions = [],
}: {
  className?: string;
  suggestions?: string[];
}) {
  const [sessionId] = useState(randomId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  async function send(raw: string) {
    const body = raw.trim();
    if (!body || pending) return;

    setMessages((prev) => [...prev, { role: "USER", body }]);
    setText("");
    setPending(true);

    try {
      const response = await fetch("/api/guest/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, message: body }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        output?: string;
        error?: string;
      };
      setMessages((prev) => [
        ...prev,
        {
          role: "ASSISTANT",
          body:
            response.ok && data.output
              ? data.output
              : (data.error ?? "Something went wrong. Please try again."),
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "ASSISTANT", body: "Something went wrong. Please try again." },
      ]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={clsx("w-full max-w-[720px]", className)}>
      {messages.length > 0 ? (
        <div className="mb-6 flex flex-col gap-4">
          {messages.map((message, index) =>
            message.role === "USER" ? (
              <div
                key={index}
                className="self-end rounded-card rounded-br-[6px] bg-fill px-4 py-2.5 text-[15px]"
              >
                {message.body}
              </div>
            ) : (
              <p key={index} className="text-[15px] leading-relaxed">
                {message.body}
              </p>
            ),
          )}
          {pending ? <p className="text-[15px] text-ink-3">Thinking…</p> : null}
        </div>
      ) : null}

      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void send(text);
        }}
      >
        <div className="rounded-composer border border-line bg-canvas py-4 pr-3 pb-3 pl-5 shadow-[0_4px_24px_rgba(0,0,0,0.05)]">
          <textarea
            rows={1}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              event.target.style.height = "auto";
              event.target.style.height = `${event.target.scrollHeight}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && text.trim()) {
                event.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
            placeholder="Ask anything, or describe a task…"
            className="max-h-48 w-full resize-none bg-transparent text-base leading-7 placeholder:text-ink-3 focus:outline-none"
          />
          <div className="mt-3.5 flex items-center justify-end">
            <button
              type="submit"
              aria-label="Send"
              disabled={!text.trim() || pending}
              className={clsx(
                "flex size-9 items-center justify-center rounded-full",
                !text.trim() || pending ? "bg-selected text-ink-3" : "bg-ink text-white",
              )}
            >
              <ArrowUp size={18} strokeWidth={2} />
            </button>
          </div>
        </div>
      </form>

      {suggestions.length > 0 && messages.length === 0 && !text ? (
        <div className="mt-7 flex flex-col">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => void send(suggestion)}
              className="flex h-[46px] items-center gap-3.5 rounded-[12px] px-3 text-left text-[15px] text-ink-2 hover:bg-fill"
            >
              <Sparkles size={17} strokeWidth={1.8} className="flex-none text-ink-3" />
              <span className="truncate">{suggestion}</span>
            </button>
          ))}
        </div>
      ) : null}

      <p className="mt-6 text-center text-xs text-ink-3">
        You’re browsing as a guest — this conversation is not saved and ends
        when you close this tab.{" "}
        <Link href="/login" className="text-link hover:text-link-strong">
          Log in
        </Link>{" "}
        to run products you own and keep your history.
      </p>
    </div>
  );
}
