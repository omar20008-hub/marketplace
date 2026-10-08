import "server-only";
import { timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * Whether a request carries the channel token (x-channel-token). Empty
 * CHANNEL_TOKEN refuses every caller, so an unconfigured deployment has no open
 * endpoint. The comparison is constant-time.
 */
export function channelCallAuthorised(request: Request): boolean {
  const expected = env.channelToken;
  if (!expected) return false;
  const given = request.headers.get("x-channel-token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
