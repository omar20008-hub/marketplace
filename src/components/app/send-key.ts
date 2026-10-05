/**
 * Enter sends, Shift+Enter starts a new line. A key that is part of an input method
 * still composing a word (an IME) is left alone, and the physical key is checked as
 * well as the character, so a keyboard layout or a test driver that reports one but
 * not the other still sends.
 */
export function isSendKey(event: {
  key: string;
  code?: string;
  keyCode?: number;
  shiftKey: boolean;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  if (event.shiftKey || event.nativeEvent?.isComposing) return false;
  return (
    event.key === "Enter" ||
    event.code === "Enter" ||
    event.code === "NumpadEnter" ||
    event.keyCode === 13
  );
}
