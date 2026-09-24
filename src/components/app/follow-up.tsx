"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { ArrowUp } from "lucide-react";
import clsx from "clsx";
import { followUp } from "@/server/thread-actions";

function Send({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-label="Send"
      disabled={disabled || pending}
      className={clsx(
        "flex size-9 flex-none items-center justify-center rounded-full",
        disabled || pending ? "bg-selected text-ink-3" : "bg-ink text-white",
      )}
    >
      <ArrowUp size={18} strokeWidth={2} />
    </button>
  );
}

export function FollowUp({ threadId }: { threadId: string }) {
  const [text, setText] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        setText("");
        await followUp(formData);
      }}
      className="flex items-end gap-2 rounded-composer border border-line bg-canvas py-2.5 pr-2.5 pl-5"
    >
      <input type="hidden" name="threadId" value={threadId} />
      <textarea
        name="message"
        rows={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && text.trim()) {
            event.preventDefault();
            formRef.current?.requestSubmit();
          }
        }}
        placeholder="Ask a follow-up or change the inputs…"
        className="max-h-32 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[15px] placeholder:text-ink-3 focus:outline-none"
      />
      <Send disabled={!text.trim()} />
    </form>
  );
}
