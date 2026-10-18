"use client";

import clsx from "clsx";
import { Mic, MicOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { parseVoiceCommand, type VoiceCommand } from "./voice";

/**
 * Speech to text through the browser's own recognition. Nothing is uploaded by
 * this code; Chrome and Edge send the audio to their speech service, and Safari
 * handles it on the device. Firefox has no recognition, so the button is not drawn.
 */

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

function recognitionConstructor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** One phrase per tap: listening stops by itself when the person pauses. */
export function useVoice({
  onText,
  onCommand,
}: {
  onText: (spoken: string) => void;
  onCommand: (command: Exclude<VoiceCommand, { kind: "text" }>) => void;
}) {
  // The server renders without the button; the browser decides once it hydrates.
  const supported = useSyncExternalStore(
    () => () => {},
    () => recognitionConstructor() !== null,
    () => false,
  );
  const [listening, setListening] = useState(false);
  const active = useRef<RecognitionLike | null>(null);
  const handlers = useRef({ onText, onCommand });

  useEffect(() => {
    handlers.current = { onText, onCommand };
  }, [onText, onCommand]);

  useEffect(() => () => active.current?.abort(), []);

  const toggle = useCallback(() => {
    if (active.current) {
      active.current.stop();
      return;
    }
    const Ctor = recognitionConstructor();
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result.isFinal) continue;
        const command = parseVoiceCommand(result[0].transcript);
        if (command.kind === "text") handlers.current.onText(command.text);
        else handlers.current.onCommand(command);
      }
    };
    const finish = () => {
      active.current = null;
      setListening(false);
    };
    recognition.onend = finish;
    recognition.onerror = finish;

    try {
      recognition.start();
      active.current = recognition;
      setListening(true);
    } catch {
      finish();
    }
  }, []);

  return { supported, listening, toggle };
}

export function VoiceButton({ listening, onToggle }: { listening: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={listening ? "Stop listening" : "Speak your message"}
      aria-pressed={listening}
      title={listening ? "Stop listening" : "Speak. Say “send” to send or “clear” to clear."}
      onClick={onToggle}
      className={clsx(
        "flex size-[34px] flex-none items-center justify-center rounded-full border",
        listening ? "border-ink bg-ink text-white" : "border-line text-ink-2 hover:bg-fill",
      )}
    >
      {listening ? <MicOff size={15} strokeWidth={1.8} /> : <Mic size={15} strokeWidth={1.8} />}
    </button>
  );
}
