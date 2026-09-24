"use client";

import clsx from "clsx";
import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { ArrowUp, CalendarClock, Grid2x2, Mic, Plus, Sparkles } from "lucide-react";
import { startTask } from "@/server/run-actions";

function SendButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-label="Send"
      disabled={disabled || pending}
      className={clsx(
        "flex size-9 items-center justify-center rounded-full",
        disabled || pending ? "bg-selected text-ink-3" : "bg-ink text-white",
      )}
    >
      <ArrowUp size={18} strokeWidth={2} />
    </button>
  );
}

export function Composer({
  className,
  suggestions = [],
  products = [],
}: {
  className?: string;
  suggestions?: string[];
  products?: { id: string; title: string }[];
}) {
  const [text, setText] = useState("");
  const [pinned, setPinned] = useState<string>("");
  const [picking, setPicking] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const pinnedTitle = products.find((p) => p.id === pinned)?.title;

  return (
    <div className={clsx("w-full max-w-[720px]", className)}>
      <form ref={formRef} action={startTask}>
        <input type="hidden" name="installationId" value={pinned} />
        <div className="rounded-composer border border-line bg-canvas py-4 pr-3 pb-3 pl-5 shadow-[0_4px_24px_rgba(0,0,0,0.05)]">
          <textarea
            name="task"
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
            placeholder="Describe your task…"
            className="max-h-48 w-full resize-none bg-transparent text-base leading-7 placeholder:text-ink-3 focus:outline-none"
          />

          <div className="mt-3.5 flex items-center justify-between gap-2">
            <div className="-ml-2 flex items-center gap-1.5">
              <button
                type="button"
                aria-label="Attach"
                className="flex size-9 items-center justify-center rounded-full text-ink-2 hover:bg-fill"
              >
                <Plus size={18} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                onClick={() => setPicking((open) => !open)}
                className={clsx(
                  "flex h-[34px] items-center gap-1.5 rounded-full border px-3 text-[13px] whitespace-nowrap",
                  pinned
                    ? "border-ink bg-ink text-white"
                    : "border-line text-ink-2 hover:bg-fill",
                )}
              >
                <Grid2x2 size={15} strokeWidth={1.8} />
                {pinnedTitle ?? "Pick a product"}
              </button>
              <button
                type="button"
                className="flex h-[34px] items-center gap-1.5 rounded-full border border-line px-3 text-[13px] whitespace-nowrap text-ink-2 hover:bg-fill"
              >
                <CalendarClock size={15} strokeWidth={1.8} />
                Schedule
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="Dictate"
                className="flex size-9 items-center justify-center rounded-full text-ink-2 hover:bg-fill"
              >
                <Mic size={18} strokeWidth={1.8} />
              </button>
              <SendButton disabled={!text.trim()} />
            </div>
          </div>
        </div>
      </form>

      {picking ? (
        <div className="mt-2 flex flex-col rounded-card border border-selected p-1.5">
          <button
            type="button"
            onClick={() => {
              setPinned("");
              setPicking(false);
            }}
            className="rounded-row px-2.5 py-2 text-left text-sm text-ink-2 hover:bg-fill"
          >
            Let Builder choose
          </button>
          {products.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() => {
                setPinned(product.id);
                setPicking(false);
              }}
              className="rounded-row px-2.5 py-2 text-left text-sm hover:bg-fill"
            >
              {product.title}
            </button>
          ))}
        </div>
      ) : null}

      {suggestions.length > 0 && !text ? (
        <div className="mt-7 flex flex-col">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => setText(suggestion)}
              className="flex h-[46px] items-center gap-3.5 rounded-[12px] px-3 text-left text-[15px] text-ink-2 hover:bg-fill"
            >
              <Sparkles size={17} strokeWidth={1.8} className="flex-none text-ink-3" />
              <span className="truncate">{suggestion}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
