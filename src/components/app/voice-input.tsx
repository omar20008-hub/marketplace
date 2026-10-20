"use client";

import { Check, Loader2, Mic, X } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import {
  clock,
  concatSamples,
  downsample,
  encodeWav,
  IDLE,
  MAX_RECORDING_SECONDS,
  parseVoiceCommand,
  voiceReducer,
  WAV_SAMPLE_RATE,
  type VoiceCommand,
  type VoiceState,
} from "./voice";

/**
 * Voice input for the chat box. Tapping the microphone opens a recording bar; the
 * check sends the recording to the platform, which works out the language it was
 * spoken in and writes it down in that language. The words go into the box, not
 * into the conversation: the person still presses send. X throws the recording away.
 *
 * The browser only records. The recording goes to /api/voice/transcribe and is not
 * kept after it is written down.
 */

type AudioCtor = typeof AudioContext;

function audioContextConstructor(): AudioCtor | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext ?? null;
}

function canRecord(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    audioContextConstructor() !== null
  );
}

type Session = {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
};

function endSession(session: Session | null) {
  if (!session) return;
  session.processor.onaudioprocess = null;
  session.processor.disconnect();
  session.source.disconnect();
  session.stream.getTracks().forEach((track) => track.stop());
  void session.context.close();
}

/** Under this much audio there is nothing worth sending. */
const MIN_SECONDS = 0.4;

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
    canRecord,
    () => false,
  );
  const [state, dispatch] = useReducer(voiceReducer, IDLE);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const session = useRef<Session | null>(null);
  const handlers = useRef({ onText, onCommand });

  useEffect(() => {
    handlers.current = { onText, onCommand };
  }, [onText, onCommand]);

  // Leaving the page ends any recording and releases the microphone.
  useEffect(() => () => endSession(session.current), []);

  const close = useCallback(() => {
    endSession(session.current);
    session.current = null;
    setAnalyser(null);
  }, []);

  const start = useCallback(async () => {
    if (session.current || state.phase !== "idle") return;
    const Ctor = audioContextConstructor();
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
      dispatch({ type: "stopped", notice: "This browser cannot record audio." });
      return;
    }
    dispatch({ type: "start" });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = (error as { name?: string }).name;
      dispatch({
        type: "stopped",
        notice:
          name === "NotFoundError"
            ? "No microphone was found."
            : "Microphone access was blocked. Allow it in the site settings, then try again.",
      });
      return;
    }

    const context = new Ctor();
    const source = context.createMediaStreamSource(stream);
    const meter = context.createAnalyser();
    meter.fftSize = 128;
    // ScriptProcessorNode is deprecated but is the one capture path every browser has
    // without loading a worklet file.
    const processor = context.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    processor.onaudioprocess = (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(meter);
    source.connect(processor);
    processor.connect(context.destination);

    session.current = { stream, context, source, processor, chunks };
    setAnalyser(meter);
  }, [state.phase]);

  const cancel = useCallback(() => {
    close();
    dispatch({ type: "stopped" });
  }, [close]);

  const confirm = useCallback(async () => {
    const current = session.current;
    if (!current) return;
    const rate = current.context.sampleRate;
    const samples = concatSamples(current.chunks);
    close();

    if (samples.length < rate * MIN_SECONDS) {
      dispatch({ type: "stopped", notice: "Nothing was heard. Tap the microphone and try again." });
      return;
    }
    dispatch({ type: "sent" });

    const wav = encodeWav(downsample(samples, rate, WAV_SAMPLE_RATE), WAV_SAMPLE_RATE);
    const form = new FormData();
    form.append("audio", new Blob([wav], { type: "audio/wav" }), "recording.wav");

    let notice: string | undefined;
    try {
      const response = await fetch("/api/voice/transcribe", { method: "POST", body: form });
      const body = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
      if (response.ok && typeof body.text === "string" && body.text.trim()) {
        const command = parseVoiceCommand(body.text);
        if (command.kind === "text") handlers.current.onText(command.text);
        else handlers.current.onCommand(command);
      } else {
        notice = body.error ?? "The recording could not be written down. Try again.";
      }
    } catch {
      notice = "The recording could not be sent. Check the connection and try again.";
    }
    dispatch({ type: "stopped", notice });
  }, [close]);

  useEffect(() => {
    if (state.phase !== "listening") return;
    const timer = setInterval(() => dispatch({ type: "tick" }), 1000);
    return () => clearInterval(timer);
  }, [state.phase]);

  // A recording that reaches the limit is sent as if the check had been pressed.
  const atLimit = state.phase === "listening" && state.seconds >= MAX_RECORDING_SECONDS;
  useEffect(() => {
    if (atLimit) void confirm();
  }, [atLimit, confirm]);

  return {
    supported,
    state,
    analyser,
    start: () => void start(),
    confirm: () => void confirm(),
    cancel,
  };
}

export function VoiceButton({ onStart }: { onStart: () => void }) {
  return (
    <button
      type="button"
      aria-label="Speak your message"
      title="Speak in any language. Say “send” to send or “clear” to clear."
      onClick={onStart}
      className="flex size-[34px] flex-none items-center justify-center rounded-full border border-line text-ink-2 hover:bg-fill"
    >
      <Mic size={15} strokeWidth={1.8} />
    </button>
  );
}

/** The bar that replaces the composer's buttons while recording: cancel, waveform, time, confirm. */
export function VoiceBar({
  state,
  analyser,
  onConfirm,
  onCancel,
}: {
  state: VoiceState;
  analyser: AnalyserNode | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (state.phase === "idle") return null;

  if (state.phase === "transcribing") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-12 items-center justify-center gap-2 rounded-full border border-line bg-canvas text-[13px] text-ink-3"
      >
        <Loader2 size={15} className="animate-spin" />
        Writing it down…
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded-full border border-line bg-canvas p-1.5"
    >
      <button
        type="button"
        aria-label="Cancel recording"
        onClick={onCancel}
        className="flex size-9 flex-none items-center justify-center rounded-full bg-ink text-white"
      >
        <X size={16} strokeWidth={2} />
      </button>
      <Waveform analyser={analyser} />
      <span className="w-10 flex-none text-right text-[13px] tabular-nums text-ink-3">{clock(state.seconds)}</span>
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

function Waveform({ analyser }: { analyser: AnalyserNode | null }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const per = Math.max(1, Math.floor(data.length / BARS));
    let frame = 0;
    const draw = () => {
      analyser.getByteFrequencyData(data);
      bars.current.forEach((bar, i) => {
        if (!bar) return;
        let sum = 0;
        for (let j = 0; j < per; j++) sum += data[i * per + j] ?? 0;
        bar.style.height = `${Math.max(4, Math.round((sum / per / 255) * 30))}px`;
      });
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [analyser]);

  return (
    <div className="flex h-8 min-w-0 flex-1 items-center justify-center gap-[3px] overflow-hidden">
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="w-[3px] rounded-full bg-ink-3"
          style={{ height: 4 }}
        />
      ))}
    </div>
  );
}

/** A short line under the box when a recording ended without text, saying why. */
export function VoiceNotice({ notice }: { notice?: string }) {
  if (!notice) return null;
  return (
    <p role="status" className="mt-2 text-[13px] text-ink-3">
      {notice}
    </p>
  );
}
