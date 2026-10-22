import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { hit } from "@/lib/rate-limit";
import { publicOrigin } from "@/lib/public-origin";
import { MAX_FILE_BYTES } from "@/lib/file-text";
import { mediaPath, saveMedia } from "@/server/media";
import { indexInBackground, saveUserFile } from "@/server/files/user-files";

/**
 * Upload of a file attached in the chat: PDF, Word, Excel, PowerPoint, text,
 * Markdown, JSON, CSV or an image. Signed-in people only; the file is read (OCR
 * for images and scans) and kept in that person's own space.
 *
 * A JPEG or PNG is also stored as media, so it keeps working as a post's image.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limiter = hit(`files:${user.id}`, { limit: 20, windowMs: 60_000 });
  if (!limiter.ok) {
    return NextResponse.json(
      { error: "Too many uploads. Wait a moment and try again." },
      { status: 429, headers: { "retry-after": String(limiter.retryAfterSeconds) } },
    );
  }

  // The header can lie, so the size is checked again on the bytes in saveUserFile.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_FILE_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "The file is larger than 10 MB." }, { status: 413 });
  }

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return NextResponse.json({ error: "Send the file as a form upload." }, { status: 400 });
  }
  if (!(file instanceof File)) return NextResponse.json({ error: "No file was sent." }, { status: 400 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const saved = await saveUserFile({
    userId: user.id,
    fileName: file.name,
    bytes,
    declaredMime: file.type,
    channel: "platform",
  });
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
  await indexInBackground(saved.id);

  let url: string | undefined;
  if (saved.mimeType === "image/jpeg" || saved.mimeType === "image/png") {
    const media = await saveMedia(user.id, file.name, bytes);
    if (media.ok) url = new URL(mediaPath(media.token, media.kind), publicOrigin(request)).toString();
  }

  return NextResponse.json(
    { id: saved.id, name: saved.name, label: saved.label, url, readable: !saved.error, error: saved.error },
    { status: 201 },
  );
}

export const dynamic = "force-dynamic";
