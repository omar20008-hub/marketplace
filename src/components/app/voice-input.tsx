"use client";

import clsx from "clsx";
import { Check, Mic, X } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { appendTranscript, clock, IDLE, noticeFor, parseVoiceCommand, voiceReducer, type VoiceCommand } from "./voice";

/**
 * Voice input for the chat box. Tapping the microphone opens a recording bar: the
 * waveform follows the microphone, the timer counts, and the browser's recognition
 * collects the words. Nothing is sent until the person confirms with the check; X
 * throws the recording away. The browser does the recognition: Chrome and Edge send
 * the audio to their speech service, Safari keeps it on the device, and this code
 * uploads nothing. Firefox has no recognition, so the microphone is not drawn.
 */

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type RecognitionErrorEvent = { error: string };
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
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

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

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
  const [state, dispatch] = useReducer(voiceReducer, IDLE);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const active = useRef<RecognitionLike | null>(null);
  const heard = useRef("");
  const decision = useRef<"confirm" | "cancel" | null>(null);
  const problem = useRef<string | undefined>(undefined);
  const streamRef = useRef<MediaStream | null>(null);
  const handlers = useRef({ onText, onCommand });

  useEffect(() => {
    handlers.current = { onText, onCommand };
  }, [onText, onCommand]);

  useEffect(() => {
    if (state.phase !== "listening") return;
    const timer = setInterval(() => dispatch({ type: "tick" }), 1000);
    return () => clearInterval(timer);
  }, [state.phase]);

  // Leaving the page ends any recording and releases the microphone.
  useEffect(
    () => () => {
      active.current?.abort();
      stopStream(streamRef.current);
    },
    [],
  );

  const finish = useCallback(() => {
    // Only X throws the words away. If the browser ends the recognition by itself (a
    // long pause), what was said is kept and goes into the box like a confirmed one.
    const confirmed = decision.current !== "cancel";
    const words = heard.current;
    const notice = problem.current;
    active.current = null;
    decision.current = null;
    heard.current = "";
    problem.current = undefined;
    stopStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    dispatch({ type: "stopped", notice });

    if (!confirmed || !words.trim()) return;
    const command = parseVoiceCommand(words);
    if (command.kind === "text") handlers.current.onText(command.text);
    else handlers.current.onCommand(command);
  }, []);

  const start = useCallback(() => {
    if (active.current) return;
    const Ctor = recognitionConstructor();
    if (!Ctor) {
      dispatch({ type: "stopped", notice: "Speech recognition is not available in this browser." });
      return;
    }

    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) heard.current = appendTranscript(heard.current, result[0].transcript);
      }
    };
    recognition.onerror = (event) => {
      problem.current = noticeFor(event.error);
    };
    recognition.onend = finish;

    try {
      recognition.start();
    } catch {
      dispatch({ type: "stopped", notice: "Voice input could not start. Try again." });
      return;
    }
    active.current = recognition;
    heard.current = "";
    decision.current = null;
    problem.current = undefined;
    dispatch({ type: "start" });

    // The waveform needs the microphone too. If it is refused, recognition still runs
    // and the bar simply stays flat.
    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((opened) => {
        if (active.current === recognition) {
          streamRef.current = opened;
          setStream(opened);
        } else {
          stopStream(opened);
        }
      })
      .catch(() => {});
  }, [finish]);

  const confirm = useCallback(() => {
    if (!active.current) return;
    decision.current = "confirm";
    active.current.stop();
    // Some browsers do not report the end promptly; do not leave the bar open.
    const pending = active.current;
    setTimeout(() => {
      if (active.current === pending) finish();
    }, 1500);
  }, [finish]);

  const cancel = useCallback(() => {
    if (!active.current) return;
    decision.current = "cancel";
    active.current.abort();
  }, []);

  return { supported, state, stream, start, confirm, cancel };
}

export function VoiceButton({ onStart }: { onStart: () => void }) {
  return (
    <button
      type="button"
      aria-label="Speak your message"
      title="Speak. Say “send” to send or “clear” to clear."
      onClick={onStart}
      className="flex size-[34px] flex-none items-center justify-center rounded-full border border-line text-ink-2 hover:bg-fill"
    >
      <Mic size={15} strokeWidth={1.8} />
    </button>
  );
}

/** The bar that replaces the composer's buttons while listening: cancel, waveform, time, confirm. */
export function VoiceBar({
  seconds,
  stream,
  onConfirm,
  onCancel,
}: {
  seconds: number;
  stream: MediaStream | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded-full border border-line bg-canvas py-1.5 pr-1.5 pl-1.5"
    >
      <button
        type="button"
        aria-label="Cancel recording"
        onClick={onCancel}
        className="flex size-9 flex-none items-center justify-center rounded-full bg-ink text-white"
      >
        <X size={16} strokeWidth={2} />
      </button>
      <Waveform stream={stream} />
      <span className="w-10 flex-none text-right text-[13px] tabular-nums text-ink-3">{clock(seconds)}</span>
      <button
        type="button"
        aria-label="Use this recording"
        onClick={onConfirm}
        className="flex size-9 flex-none items-center justify-center rounded-full bg-link text-white"
      >
        <Check size={16} strokeWidth={2} />
      </button>
    </div>
  );
}

const BARS = 28;

function Waveform({ stream }: { stream: MediaStream | null }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (!stream) return;
    const AudioCtx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const context = new AudioCtx();
    const analyser = context.createAnalyser();
    analyser.fftSize = 128;
    context.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const per = Math.max(1, Math.floor(data.length / BARS));
    let frame = 0;

    const draw = () => {
      analyser.getByteFrequencyData(data);
      bars.current.forEach((bar, i) => {
        if (!bar) return;
        let sum = 0;
        for (let j = 0; j < per; j++) sum += data[i * per + j] ?? 0;
        const level = sum / per / 255;
        bar.style.height = `${Math.max(4, Math.round(level * 30))}px`;
      });
      frame = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(frame);
      void context.close();
    };
  }, [stream]);

  return (
    <div className="flex h-8 min-w-0 flex-1 items-center justify-center gap-[3px] overflow-hidden">
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className={clsx("w-[3px] rounded-full bg-ink-3")}
          style={{ height: 4 }}
        />
      ))}
    </div>
  );
}

/** A short line under the box when listening stopped for a reason the person should know. */
export function VoiceNotice({ notice }: { notice?: string }) {
  if (!notice) return null;
  return <p role="status" className="mt-2 text-[13px] text-ink-3">{notice}</p>;
}
