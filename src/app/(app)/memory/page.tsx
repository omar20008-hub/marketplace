import Link from "next/link";
import clsx from "clsx";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { MAX_FILES, MAX_FILE_CHARS, MAX_NAME_CHARS, fileLines } from "@/lib/memory-rules";
import { Button, Card, EmptyState, Input, PageTitle } from "@/components/ds";
import { listFiles } from "@/server/memory";
import {
  addMemoryLineAction,
  clearMemoriesAction,
  createMemoryFileAction,
  deleteMemoryFileAction,
  renameMemoryFileAction,
  saveMemoryFileAction,
  setAutoMemoryAction,
} from "@/server/memory-actions";

export const metadata = { title: "Memory · Builder" };

type Note = { text: string; tone: "ok" | "bad" };

function noteFor(code: string | undefined): Note | null {
  if (!code) return null;
  if (code.startsWith("sensitive-")) {
    return {
      text: `Not saved: line ${code.slice("sensitive-".length)} looks like a password, key, long number, email, phone or link. Remove it and save again.`,
      tone: "bad",
    };
  }
  const notes: Record<string, Note> = {
    saved: { text: "Saved.", tone: "ok" },
    created: { text: "File created.", tone: "ok" },
    renamed: { text: "Renamed.", tone: "ok" },
    deleted: { text: "File deleted.", tone: "ok" },
    cleared: { text: "Everything was deleted.", tone: "ok" },
    too_long: { text: `Not saved: a file holds at most ${MAX_FILE_CHARS} characters.`, tone: "bad" },
    full: { text: `That file is full (${MAX_FILE_CHARS} characters). Remove something first.`, tone: "bad" },
    rejected: {
      text: "That was not added: it looks like a password, a long number, an email, a phone or a link, or it is too short or too long.",
      tone: "bad",
    },
    exists: { text: "You already have a file with that name.", tone: "bad" },
    limit: { text: `You can have at most ${MAX_FILES} files.`, tone: "bad" },
    name: { text: "Give the file a name (up to 40 characters, no slashes).", tone: "bad" },
    not_found: { text: "That file no longer exists.", tone: "bad" },
    confirm: { text: "Tick the box to confirm.", tone: "bad" },
  };
  return notes[code] ?? null;
}

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ file?: string; note?: string }>;
}) {
  const user = await requireUser();
  const { file: fileParam, note } = await searchParams;
  const [files, profile] = await Promise.all([
    listFiles(user.id),
    prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { memoryAuto: true } }),
  ]);
  const selected = files.find((f) => f.id === fileParam) ?? files[0] ?? null;
  const message = noteFor(note);

  return (
    <div className="px-5 py-5 lg:px-7">
      <PageTitle title="Memory" meta={`· ${files.length} of ${MAX_FILES} files`} />
      <p className="mt-2 max-w-2xl text-[13px] text-ink-2">
        What the assistant knows about you, in every conversation, kept as a few small files you
        can read and edit. Say &ldquo;remember that …&rdquo; and it adds a line to the right file.
        Passwords, keys, card numbers, emails, phones and links are never saved.
      </p>

      {message ? (
        <p
          role={message.tone === "bad" ? "alert" : "status"}
          className={`mt-3 text-[13px] ${message.tone === "bad" ? "text-danger-ink" : "text-ready-ink"}`}
        >
          {message.text}
        </p>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-7 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <nav aria-label="Memory files" className="flex flex-col gap-1">
            {files.length === 0 ? (
              <EmptyState
                title="No files yet"
                body='Say "remember that I run a coffee shop" in a conversation, or create a file below.'
              />
            ) : (
              files.map((file) => (
                <Link
                  key={file.id}
                  href={`/memory?file=${file.id}`}
                  className={clsx(
                    "flex items-center justify-between gap-2 rounded-row px-3 py-2 text-sm hover:bg-fill",
                    selected?.id === file.id && "bg-selected font-medium",
                  )}
                >
                  <span className="truncate">{file.name}</span>
                  <span className="flex-none text-xs text-ink-3">{fileLines(file.content).length}</span>
                </Link>
              ))
            )}
          </nav>

          <Card className="p-3.5">
            <form action={createMemoryFileAction} className="flex flex-col gap-2">
              <label className="text-[13px] font-medium" htmlFor="new-file">
                New file
              </label>
              <Input id="new-file" name="name" maxLength={MAX_NAME_CHARS} placeholder="e.g. Clients" required />
              <Button type="submit" size="sm" tone="secondary">
                Create
              </Button>
            </form>
          </Card>

          <Card className="p-3.5">
            <form action={setAutoMemoryAction} className="flex flex-col gap-2">
              <input type="hidden" name="file" value={selected?.id ?? ""} />
              <label className="flex items-start gap-2 text-[13px]">
                <input type="checkbox" name="auto" defaultChecked={profile.memoryAuto} className="mt-0.5" />
                <span>
                  Learn from my messages
                  <span className="block text-xs text-ink-3">
                    Lasting facts you state about yourself are added to the right file automatically.
                    What you ask to remember is added either way.
                  </span>
                </span>
              </label>
              <Button type="submit" size="sm" tone="secondary">
                Save
              </Button>
            </form>
          </Card>

          {files.length > 0 ? (
            <Card className="p-3.5">
              <form action={clearMemoriesAction} className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" name="confirm" value="yes" />
                  Delete all my files
                </label>
                <Button type="submit" size="sm" tone="secondary">
                  Delete all
                </Button>
              </form>
            </Card>
          ) : null}
        </div>

        {selected ? (
          // Keyed by file: the fields below are uncontrolled (defaultValue), so without a
          // new key React keeps the previous file's text when you switch files.
          <div key={selected.id} className="flex min-w-0 flex-col gap-4">
            <Card className="p-4">
              <form action={saveMemoryFileAction} className="flex flex-col gap-3">
                <input type="hidden" name="id" value={selected.id} />
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-base font-medium">{selected.name}</h2>
                  <span className="text-xs text-ink-3">
                    {selected.content.length} of {MAX_FILE_CHARS} characters · updated{" "}
                    {selected.updatedAt.toISOString().slice(0, 10)}
                  </span>
                </div>
                <textarea
                  name="content"
                  defaultValue={selected.content}
                  rows={14}
                  spellCheck={false}
                  aria-label={`${selected.name} file`}
                  placeholder="One thing per line, for example: I run a coffee shop in Riyadh"
                  className="w-full rounded-row border border-line bg-canvas px-3 py-2 text-sm leading-6 placeholder:text-ink-3 focus:border-ink focus:outline-none"
                />
                <div className="flex items-center gap-3">
                  <Button type="submit" size="sm">
                    Save file
                  </Button>
                  <span className="text-xs text-ink-3">Edit freely; one fact per line works best.</span>
                </div>
              </form>
            </Card>

            <Card className="p-4">
              <form action={addMemoryLineAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="id" value={selected.id} />
                <div className="min-w-0 flex-1">
                  <label className="text-[13px] font-medium" htmlFor="add-line">
                    Add a line to {selected.name}
                  </label>
                  <Input id="add-line" name="content" maxLength={240} placeholder="e.g. I prefer short answers" required />
                </div>
                <Button type="submit" size="sm" tone="secondary">
                  Add
                </Button>
              </form>
            </Card>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Card className="p-4">
                <form action={renameMemoryFileAction} className="flex flex-col gap-2">
                  <input type="hidden" name="id" value={selected.id} />
                  <label className="text-[13px] font-medium" htmlFor="rename-file">
                    Rename
                  </label>
                  <Input id="rename-file" name="name" defaultValue={selected.name} maxLength={MAX_NAME_CHARS} required />
                  <Button type="submit" size="sm" tone="secondary">
                    Rename
                  </Button>
                </form>
              </Card>
              <Card className="p-4">
                <form action={deleteMemoryFileAction} className="flex flex-col gap-2">
                  <input type="hidden" name="id" value={selected.id} />
                  <label className="flex items-center gap-2 text-[13px]">
                    <input type="checkbox" name="confirm" value="yes" />
                    Delete this file
                  </label>
                  <Button type="submit" size="sm" tone="secondary">
                    Delete file
                  </Button>
                </form>
              </Card>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
