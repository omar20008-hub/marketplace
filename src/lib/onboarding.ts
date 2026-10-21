/**
 * The first minutes of a new account. No `server-only`: the welcome page's
 * client component builds the WhatsApp link from the same helper the tests pin.
 */

/** Where a freshly created account lands, from the sign-up form or Google. */
export const WELCOME_PATH = "/welcome";

/**
 * A wa.me link that opens a chat with the business number, the message already
 * typed. The person still presses send themselves: that message, arriving from
 * their own WhatsApp, is what proves the number is theirs.
 *
 * Null when the number has no digits, so a missing or mistyped
 * WHATSAPP_BUSINESS_NUMBER hides the button rather than opening a broken chat.
 */
export function whatsappChatUrl(businessNumber: string | null, text?: string): string | null {
  const digits = (businessNumber ?? "").replace(/\D/g, "");
  if (!digits) return null;
  const url = `https://wa.me/${digits}`;
  return text ? `${url}?text=${encodeURIComponent(text)}` : url;
}

/** The message that links a WhatsApp number. The n8n workflow reads exactly "/link <code>". */
export function whatsappLinkMessage(code: string): string {
  return `/link ${code}`;
}
