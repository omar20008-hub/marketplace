import { NextResponse } from "next/server";
import { channelCallAuthorised } from "@/lib/channel-token";
import { hit } from "@/lib/rate-limit";
import { redeemTelegramCode } from "@/server/channel-links";

/**
 * Called by n8n when a Telegram message reads "/link <code>". Body:
 * { "code": "...", "telegramUserId": "653345511" }. The platform answers with
 * the outcome only; the caller learns nothing it did not already send.
 */
export async function POST(request: Request) {
  if (!channelCallAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
  }
  const { code, telegramUserId } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof code !== "string" ||
    !/^[A-Za-z2-9]{8}$/.test(code.trim()) ||
    typeof telegramUserId !== "string" ||
    !/^\d{1,20}$/.test(telegramUserId)
  ) {
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
  }

  // Guesses per Telegram account. A code has 8 characters, but this keeps a
  // single chat from trying many of them.
  const limit = hit(`telegram-link:${telegramUserId}`, { limit: 10, windowMs: 10 * 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, reason: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const result = await redeemTelegramCode({ code, externalId: telegramUserId });
  if (!result.ok) {
    const status = result.reason === "taken" || result.reason === "used" ? 409 : 400;
    return NextResponse.json({ ok: false, reason: result.reason }, { status });
  }
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
