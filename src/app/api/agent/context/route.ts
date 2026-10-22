import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { publicOrigin } from "@/lib/public-origin";
import { bearerToken, userForAgentKey } from "@/server/agent-keys";
import { fileDownloadUrl } from "@/server/files/file-links";
import { labelOf, searchUserFiles } from "@/server/files/user-files";
import { memoryBlock } from "@/server/memory";

/**
 * What the platform keeps for a person, for their personal assistant or any
 * agent or workflow holding their agent key: their memory files, their latest
 * conversation turns on every channel, and their saved files with short-lived
 * links to the originals. With `?q=…`, also the file passages that match it.
 *
 * The person is the one the key belongs to; nothing in the request names them.
 */

const RECENT = 12;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
  const userId = await userForAgentKey(bearerToken(request));
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 2000);
  const origin = publicOrigin(request);

  const [memory, messages, files, passages] = await Promise.all([
    memoryBlock(userId),
    prisma.message.findMany({
      where: {
        thread: { userId },
        role: { in: ["USER", "ASSISTANT"] },
        createdAt: { gte: new Date(Date.now() - WINDOW_MS) },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT,
      select: { role: true, body: true, createdAt: true, thread: { select: { channel: true, title: true } } },
    }),
    prisma.userFile.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, name: true, mimeType: true, createdAt: true, error: true },
    }),
    q ? searchUserFiles(userId, q, 6) : Promise.resolve([]),
  ]);

  return NextResponse.json(
    {
      memory,
      conversation: messages.reverse().map((m) => ({
        channel: m.thread.channel ?? "platform",
        thread: m.thread.title,
        role: m.role === "USER" ? "user" : "assistant",
        text: m.body,
        at: m.createdAt.toISOString(),
      })),
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        kind: labelOf(f.mimeType),
        savedAt: f.createdAt.toISOString(),
        readable: !f.error,
        downloadUrl: fileDownloadUrl(f.id, origin),
      })),
      passages,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const dynamic = "force-dynamic";
