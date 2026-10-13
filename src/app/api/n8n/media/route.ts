import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { publicOrigin } from "@/lib/public-origin";
import { MAX_VIDEO_BYTES, mediaPath, saveGeneratedMedia } from "@/server/media";

/**
 * Inbound from a workflow that generated an image or a video for a person. The
 * bytes are stored under that person's account and answered with a link the chat
 * can show. The same shared token as the sync guards it; without it, anyone could
 * fill the platform's media store under any account.
 */

const Body = z.object({
  userId: z.string().min(1),
  name: z.string().min(1).max(120),
  base64: z.string().min(1),
});

export async function POST(request: Request) {
  const token = request.headers.get("x-sync-token");
  if (!env.n8n.syncToken || token !== env.n8n.syncToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Base64 grows a file by about a third; refuse an oversized body before reading it.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > Math.ceil((MAX_VIDEO_BYTES * 4) / 3) + 4096) {
    return NextResponse.json({ error: "The file is larger than 50 MB." }, { status: 413 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  const owner = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true } });
  if (!owner) return NextResponse.json({ error: "Unknown user" }, { status: 404 });

  const saved = await saveGeneratedMedia(
    owner.id,
    parsed.data.name,
    new Uint8Array(Buffer.from(parsed.data.base64, "base64")),
  );
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });

  return NextResponse.json(
    {
      url: new URL(mediaPath(saved.token, saved.kind), publicOrigin(request)).toString(),
      mime: saved.kind.mime,
      sizeBytes: saved.sizeBytes,
    },
    { status: 201 },
  );
}

export const dynamic = "force-dynamic";
