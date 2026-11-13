import { NextResponse } from "next/server";
import { hit } from "@/lib/rate-limit";
import { bearerToken, userForAgentKey } from "@/server/agent-keys";
import { MAX_IMAGE_BYTES, saveProof } from "@/server/media";

/**
 * A picture of what the assistant's browser saw, from the person's own agent key. It goes into their outbox and
 * is sent to them with the reply (see whatsapp/outbox), so they have evidence that does not rest on what the
 * assistant says it did. Body: the image bytes (JPEG or PNG). Header `x-caption`: a short label, URL-encoded.
 */
export async function POST(request: Request) {
  const userId = await userForAgentKey(bearerToken(request));
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!hit(`proof:${userId}`, { limit: 30, windowMs: 60_000 }).ok) {
    return NextResponse.json({ error: "Too many" }, { status: 429 });
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES + 1024) return NextResponse.json({ error: "Too large" }, { status: 413 });

  const bytes = new Uint8Array(await request.arrayBuffer());
  let caption = "";
  try {
    caption = decodeURIComponent(request.headers.get("x-caption") ?? "").slice(0, 120);
  } catch {
    caption = "";
  }
  const saved = await saveProof(userId, bytes, caption);
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
  return NextResponse.json({ ok: true }, { status: 201 });
}

export const dynamic = "force-dynamic";
