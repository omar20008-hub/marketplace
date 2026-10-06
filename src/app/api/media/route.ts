import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { hit } from "@/lib/rate-limit";
import { publicOrigin } from "@/lib/public-origin";
import { MAX_IMAGE_BYTES, mediaPath, saveMedia } from "@/server/media";

/**
 * Upload of an image attached in the chat. Signed-in people only: the session is
 * what ties the image to its owner, and an upload is stored under that user and
 * nobody else.
 */

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limiter = hit(`media:${user.id}`, { limit: 20, windowMs: 60_000 });
  if (!limiter.ok) {
    return NextResponse.json(
      { error: "Too many uploads. Wait a moment and try again." },
      { status: 429, headers: { "retry-after": String(limiter.retryAfterSeconds) } },
    );
  }

  // Refuse an oversized body before reading it. The header can lie, so the size is
  // checked again on the bytes themselves in saveMedia.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "The image is larger than 8 MB." }, { status: 413 });
  }

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return NextResponse.json({ error: "Send the image as a form upload." }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No image was sent." }, { status: 400 });
  }

  const saved = await saveMedia(user.id, file.name, new Uint8Array(await file.arrayBuffer()));
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });

  return NextResponse.json(
    {
      url: new URL(mediaPath(saved.token, saved.kind), publicOrigin(request)).toString(),
      name: saved.name,
      mime: saved.kind.mime,
      sizeBytes: saved.sizeBytes,
    },
    { status: 201 },
  );
}

export const dynamic = "force-dynamic";
