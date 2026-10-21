import { NextResponse } from "next/server";
import { channelCallAuthorised } from "@/lib/channel-token";
import { hit } from "@/lib/rate-limit";
import { MAX_FILE_BYTES } from "@/lib/file-text";
import { resolveChannelUser, WHATSAPP } from "@/server/channel-links";
import { describeFiles, indexInBackground, saveUserFile } from "@/server/files/user-files";

/**
 * Called by n8n when a WhatsApp message carries a document or an image. n8n has
 * already downloaded the media from WhatsApp; it posts the bytes here as a form
 * (fields `whatsappUserId` and `file`). The file is read (OCR for images and
 * scans), kept in the linked person's space, and the note to append to the
 * message for the orchestrator comes back as `note`.
 *
 * 404 when the chat is not linked; the caller should then refuse to answer.
 */
export async function POST(request: Request) {
  if (!channelCallAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_FILE_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "The file is larger than 10 MB." }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Send the file as a form upload." }, { status: 400 });
  }
  const whatsappUserId = form.get("whatsappUserId");
  const file = form.get("file");
  if (typeof whatsappUserId !== "string" || !/^\d{1,20}$/.test(whatsappUserId) || !(file instanceof File)) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const userId = await resolveChannelUser(WHATSAPP, whatsappUserId);
  if (!userId) return NextResponse.json({ error: "Not linked" }, { status: 404 });

  const limiter = hit(`files:${userId}`, { limit: 20, windowMs: 60_000 });
  if (!limiter.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  // WhatsApp sends a document's own name; an image arrives without one.
  const name = String(form.get("fileName") ?? "").trim() || file.name || "whatsapp-file";
  const saved = await saveUserFile({
    userId,
    fileName: name,
    bytes: new Uint8Array(await file.arrayBuffer()),
    declaredMime: String(form.get("mimeType") ?? "") || file.type,
    channel: "whatsapp",
  });
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
  await indexInBackground(saved.id);

  return NextResponse.json(
    { fileId: saved.id, name: saved.name, readable: !saved.error, note: describeFiles([saved]).forAssistant },
    { status: 201 },
  );
}

export const dynamic = "force-dynamic";
