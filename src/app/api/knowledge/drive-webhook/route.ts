import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { enqueue } from "@/server/knowledge/queue";

/**
 * Where Google Drive calls when a watched account's change feed moves.
 *
 * The body is empty; everything is in headers. The channel id says which source,
 * and the token — a secret we chose when the channel was created and Google
 * echoes back — says the call is Google's. It does no work itself: it queues a
 * job and answers at once, because Google retries anything slow or failing.
 *
 * Unknown channels get a quiet 200. They are the old side of a renewal or a
 * removed source, and an error would only make Google keep trying.
 */
export async function POST(request: Request) {
  const channelId = request.headers.get("x-goog-channel-id");
  const presented = request.headers.get("x-goog-channel-token") ?? "";
  const state = request.headers.get("x-goog-resource-state");
  if (!channelId) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const source = await prisma.knowledgeSource.findUnique({
    where: { channelId },
    select: { id: true, channelToken: true },
  });
  if (!source?.channelToken) return NextResponse.json({ ok: true });

  const expected = Buffer.from(source.channelToken);
  const given = Buffer.from(presented);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // "sync" is Google saying the channel now exists. Nothing has changed yet.
  if (state !== "sync") {
    // A few seconds' delay folds a burst of edits into one read of the feed.
    await enqueue("SYNC_CHANGES", source.id, 5);
  }
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
