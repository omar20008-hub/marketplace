import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { publicOrigin } from "@/lib/public-origin";
import { bearerToken, userForAgentKey } from "@/server/agent-keys";
import { fileDownloadUrl } from "@/server/files/file-links";
import { labelOf, searchUserFiles } from "@/server/files/user-files";
import { memoryBlock } from "@/server/memory";
import { searchConversation } from "@/server/conversation-memory";

/**
 * What the platform keeps for a person, for their personal assistant or any
 * agent or workflow holding their agent key: their memory files, the summary of
 * each conversation, their latest conversation turns on every channel, and their
 * saved files with short-lived links to the originals. With `?q=…`, also the file
 * passages and the past messages (from all of their conversations) that match it.
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

  const [memory, summaries, messages, files, passages, history] = await Promise.all([
    memoryBlock(userId),
    prisma.thread.findMany({
      where: { userId, summary: { not: "" } },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { title: true, channel: true, summary: true, updatedAt: true },
    }),
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
    q ? searchConversation(userId, q, 8) : Promise.resolve([]),
  ]);

  return NextResponse.json(
    {
      memory,
      summaries: summaries.map((t) => ({
        channel: t.channel ?? "platform",
        thread: t.title,
        summary: t.summary,
        updatedAt: t.updatedAt.toISOString(),
      })),
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
      history,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const dynamic = "force-dynamic";
