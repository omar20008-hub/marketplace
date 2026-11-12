import { NextResponse } from "next/server";
import { bearerToken, userForAgentKey } from "@/server/agent-keys";

/**
 * Who an agent key belongs to. A service that acts for many people at once (the
 * browser broker) holds a key per request and needs to know whose it is, to keep
 * one person's session and files apart from another's. The answer is the person's
 * own id, given to the holder of their own key and to nobody else; nothing in the
 * request names a person.
 */

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const userId = await userForAgentKey(bearerToken(request));
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  return NextResponse.json({ userId }, { headers: NO_STORE });
}

export const dynamic = "force-dynamic";
