import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { installationForKey } from "@/server/knowledge/keys";

/**
 * Inbound from a workflow that finished work after its chat reply had already gone
 * out (a video takes longer than the connection to the chat stays open). The text,
 * which carries the media link, is added to the thread the request came from.
 *
 * The session id is the one the Orchestrator was given: "<userId>|<threadId>". The
 * caller authenticates with an installation key, and the key's owner must be the user
 * in that session id, so a workflow cannot write into someone else's thread.
 */

const Body = z.object({
  sessionId: z.string().min(1).max(200),
  text: z.string().min(1).max(8000),
});

export async function POST(request: Request) {
  const installation = await installationForKey(request.headers.get("authorization"));
  if (!installation) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  const [userId, threadId, ...rest] = parsed.data.sessionId.split("|");
  if (!userId || !threadId || rest.length > 0) {
    return NextResponse.json({ error: "Bad session" }, { status: 400 });
  }
  if (userId !== installation.userId) {
    return NextResponse.json({ error: "Not this installation's owner" }, { status: 403 });
  }

  const thread = await prisma.thread.findFirst({ where: { id: threadId, userId } });
  if (!thread) return NextResponse.json({ error: "Unknown thread" }, { status: 404 });

  await prisma.message.create({
    data: { threadId, role: "ASSISTANT", body: parsed.data.text },
  });
  await prisma.thread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });

  return NextResponse.json({ ok: true }, { status: 201 });
}

export const dynamic = "force-dynamic";
