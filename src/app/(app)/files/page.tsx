import { requireUser } from "@/lib/auth";
import { Button, Card, FootNote, PageTitle } from "@/components/ds";
import { labelOf, listUserFiles, MAX_FILES_PER_USER } from "@/server/files/user-files";
import { removeFileAction } from "@/server/file-actions";

export const metadata = { title: "Files · Builder" };

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The files the person has sent in a conversation, from the chat here or from
 * WhatsApp. The assistant reads them when a later message needs them; removing
 * one removes the text read from it too.
 */
export default async function FilesPage() {
  const user = await requireUser();
  const files = await listUserFiles(user.id);

  return (
    <div className="px-5 py-5 lg:px-7">
      <PageTitle title="Files" meta={`· ${files.length} of ${MAX_FILES_PER_USER}`} />

      <p className="mt-3 max-w-2xl text-[13px] text-ink-2">
        Files you attach in a conversation, here or on WhatsApp, are kept in your own space. Your
        assistant reads their text (images and scans too) and finds them again when you ask about
        them later.
      </p>

      <div className="mt-5 flex flex-col gap-2">
        {files.length === 0 ? (
          <Card className="p-4 text-sm text-ink-3">
            No files yet. Attach one in a conversation with the paperclip button, or send it to
            your assistant on WhatsApp.
          </Card>
        ) : (
          files.map((file) => (
            <Card key={file.id} className="flex flex-wrap items-center gap-3 p-3.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{file.name}</div>
                <div className="mt-0.5 text-xs text-ink-3">
                  {labelOf(file.mimeType)} · {size(file.sizeBytes)} ·{" "}
                  {file.channel === "whatsapp" ? "from WhatsApp" : "from the chat"} ·{" "}
                  {file.createdAt.toLocaleDateString()}
                  {file.error ? ` · text not read: ${file.error}` : ""}
                </div>
              </div>
              <form action={removeFileAction}>
                <input type="hidden" name="id" value={file.id} />
                <Button tone="danger" size="sm" type="submit">
                  Remove
                </Button>
              </form>
            </Card>
          ))
        )}
      </div>

      <div className="mt-4">
        <FootNote>Files of up to 10 MB: PDF, Word, Excel, PowerPoint, text, Markdown, JSON, CSV and images.</FootNote>
      </div>
    </div>
  );
}
