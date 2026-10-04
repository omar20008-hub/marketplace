import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { MAX_FACT_CHARS, MAX_MEMORIES } from "@/lib/memory-rules";
import { Badge, Button, Card, EmptyState, Input, PageTitle } from "@/components/ds";
import { listMemories } from "@/server/memory";
import {
  addMemoryAction,
  clearMemoriesAction,
  deleteMemoryAction,
  setAutoMemoryAction,
} from "@/server/memory-actions";

export const metadata = { title: "Memory · Builder" };

const NOTES: Record<string, { text: string; tone: "ok" | "bad" }> = {
  saved: { text: "Saved.", tone: "ok" },
  cleared: { text: "Everything was deleted.", tone: "ok" },
  rejected: {
    text: "That was not saved: it looks like a password, a long number, an email, a phone or a link, or it is too short or too long.",
    tone: "bad",
  },
  full: {
    text: `Your memory is full (${MAX_MEMORIES} things you wrote yourself). Delete some first.`,
    tone: "bad",
  },
  confirm: { text: "Tick the box to confirm deleting everything.", tone: "bad" },
};

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string }>;
}) {
  const user = await requireUser();
  const { note } = await searchParams;
  const [memories, profile] = await Promise.all([
    listMemories(user.id),
    prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { memoryAuto: true } }),
  ]);
  const message = note ? NOTES[note] : undefined;

  return (
    <div className="px-5 py-5 lg:px-7">
      <PageTitle title="Memory" meta={`· ${memories.length} of ${MAX_MEMORIES}`} />
      <p className="mt-2 max-w-2xl text-[13px] text-ink-2">
        What the assistant remembers about you, in every conversation. It is added to your
        messages so answers fit you. Passwords, keys, card numbers, emails, phones and links
        are never saved. You can delete anything here at any time.
      </p>

      {message ? (
        <p
          role={message.tone === "bad" ? "alert" : "status"}
          className={`mt-3 text-[13px] ${message.tone === "bad" ? "text-danger-ink" : "text-ready-ink"}`}
        >
          {message.text}
        </p>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-7 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-2">
          {memories.length === 0 ? (
            <EmptyState
              title="Nothing remembered yet"
              body='Write "remember that I run a coffee shop" in a conversation, or add something here.'
            />
          ) : (
            memories.map((memory) => (
              <Card key={memory.id} className="flex flex-wrap items-center gap-3 p-3.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{memory.content}</div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    {memory.source === "EXPLICIT" ? "You asked" : "Learned from your messages"} ·{" "}
                    {memory.updatedAt.toISOString().slice(0, 10)}
                  </div>
                </div>
                <Badge tone={memory.source === "EXPLICIT" ? "ready" : "platform"}>
                  {memory.source === "EXPLICIT" ? "Yours" : "Learned"}
                </Badge>
                <form action={deleteMemoryAction}>
                  <input type="hidden" name="id" value={memory.id} />
                  <button type="submit" className="text-[13px] text-ink-2 hover:text-danger-ink">
                    Delete
                  </button>
                </form>
              </Card>
            ))
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <form action={addMemoryAction} className="flex flex-col gap-2">
              <label className="text-[13px] font-medium" htmlFor="memory-content">
                Add something
              </label>
              <Input
                id="memory-content"
                name="content"
                maxLength={MAX_FACT_CHARS}
                placeholder="e.g. I run a coffee shop in Riyadh"
                required
              />
              <Button type="submit" size="sm">
                Remember
              </Button>
            </form>
          </Card>

          <Card className="p-4">
            <form action={setAutoMemoryAction} className="flex flex-col gap-2">
              <label className="flex items-start gap-2 text-[13px]">
                <input type="checkbox" name="auto" defaultChecked={profile.memoryAuto} className="mt-0.5" />
                <span>
                  Learn from my messages
                  <span className="block text-xs text-ink-3">
                    Lasting facts you state about yourself (name, work, preferences) are saved
                    automatically. What you ask to remember is kept either way.
                  </span>
                </span>
              </label>
              <Button type="submit" size="sm" tone="secondary">
                Save
              </Button>
            </form>
          </Card>

          {memories.length > 0 ? (
            <Card className="p-4">
              <form action={clearMemoriesAction} className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" name="confirm" value="yes" />
                  Delete everything the assistant remembers
                </label>
                <Button type="submit" size="sm" tone="secondary">
                  Delete all
                </Button>
              </form>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
