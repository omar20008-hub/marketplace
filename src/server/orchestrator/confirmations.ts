/**
 * Write actions wait for the person. The engine asks the gate before it runs a
 * write, and the gate answers yes only when the person confirmed this exact action
 * in a message sent after it was proposed. A model that skips the question gets no
 * run: the gate is the code path, not the prompt.
 */

export interface ConfirmationGate {
  /** True only for an exact earlier proposal that the person has just confirmed. Consumes it. */
  confirmed(installationId: string, args: Record<string, unknown>): Promise<boolean>;
  /** Remembers a proposed write so a later confirmation can match it. */
  propose(installationId: string, args: Record<string, unknown>): Promise<void>;
}

/** Fails closed: nothing is ever confirmed, so no write runs without a gate. */
export const NO_CONFIRMATION: ConfirmationGate = {
  confirmed: async () => false,
  propose: async () => {},
};

const AFFIRMATIONS = new Set([
  "نعم",
  "اي",
  "إي",
  "ايوه",
  "أيوه",
  "أكد",
  "اكد",
  "تأكيد",
  "تاكيد",
  "موافق",
  "موافقة",
  "تمام",
  "اوكي",
  "أوكي",
  "نفذ",
  "نفّذ",
  "ارسل",
  "أرسل",
  "ok",
  "okay",
  "yes",
  "confirm",
]);

/**
 * A short reply made only of affirmations ("نعم"، "نعم، أكد"، "yes confirm").
 * Anything with a condition or a change in it ("نعم لكن غيّر الوقت") is not one.
 */
export function isAffirmation(message: string): boolean {
  const tokens = message
    .toLowerCase()
    .replace(/[.!?؟،,;:\s]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  return tokens.length > 0 && tokens.length <= 3 && tokens.every((token) => AFFIRMATIONS.has(token));
}

/** Same arguments in any key order give the same key. */
export function argsKey(args: Record<string, unknown>): string {
  return JSON.stringify(sortKeys(args));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
