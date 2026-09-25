import { NextResponse } from "next/server";
import { hit } from "@/lib/rate-limit";
import { askOrchestrator } from "@/server/run-engine";

/**
 * The Orchestrator, for someone with no account at all.
 *
 * No session, no Thread, no Message row — a guest's conversation lives only in
 * the browser tab that is having it, and this route writes nothing to the
 * database on either side of the exchange. What it does is the same thing
 * startTask() and followUp() do for a signed-in person: hand the message to
 * n8n.chat() and show back whatever it answers.
 *
 * The one thing this route must get right that those two do not have to
 * worry about: sessionId decides which tools the Orchestrator shows, and here
 * it comes from someone who has proven nothing. A guest who sent a real
 * user's id as their "session" would, if the Orchestrator trusted it, be
 * looking at that user's installations. So the id this route actually sends
 * is never the one the browser supplied — it is that value behind a fixed
 * "guest:" prefix, chosen so nothing a browser could construct is
 * distinguishable from every other guest tab and no browser input can ever
 * collide with a real user's id (a cuid, which this prefix cannot be).
 */

const MAX_MESSAGE_LENGTH = 4000;
const MAX_CLIENT_ID_LENGTH = 128;

/** Keeps one guest tab from flooding the Orchestrator by itself. */
const PER_SESSION_LIMIT = 20;
/**
 * A second, looser budget per address. The platform sits behind a proxy it
 * does not control, so this header is a claim, not a fact — see the same note
 * on the sign-in limiter in auth-actions.ts. It still raises the cost of
 * generating a fresh session id for every message to get around the limit
 * above, which is the only thing it is for.
 */
const PER_ADDRESS_LIMIT = 60;
const WINDOW_MS = 10 * 60 * 1000;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send valid JSON." }, { status: 400 });
  }

  const clientSessionId =
    typeof (body as { sessionId?: unknown })?.sessionId === "string"
      ? (body as { sessionId: string }).sessionId
      : "";
  const message =
    typeof (body as { message?: unknown })?.message === "string"
      ? (body as { message: string }).message.trim()
      : "";

  if (!clientSessionId || clientSessionId.length > MAX_CLIENT_ID_LENGTH) {
    return NextResponse.json({ error: "Missing or invalid sessionId." }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ error: "Message cannot be empty." }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.` },
      { status: 400 },
    );
  }

  // Never the client's own value — see the module comment.
  const sessionId = `guest:${clientSessionId}`;

  const sessionLimit = hit(`guest-chat:session:${sessionId}`, {
    limit: PER_SESSION_LIMIT,
    windowMs: WINDOW_MS,
  });
  if (!sessionLimit.ok) {
    return NextResponse.json(
      { error: "Too many messages in this conversation. Try again in a few minutes." },
      { status: 429 },
    );
  }

  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const addressLimit = hit(`guest-chat:address:${address}`, {
    limit: PER_ADDRESS_LIMIT,
    windowMs: WINDOW_MS,
  });
  if (!addressLimit.ok) {
    return NextResponse.json(
      { error: "Too many messages right now. Try again in a few minutes." },
      { status: 429 },
    );
  }

  const output = await askOrchestrator(sessionId, message);
  return NextResponse.json({ output });
}

export const dynamic = "force-dynamic";
