import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { MicCapture } from "@/lib/audio/mic";
import { player } from "@/lib/audio/player";
import { computePeaks, type PeakBucket } from "@/lib/audio/process";
import { resample, TARGET_SAMPLE_RATE } from "@/lib/audio/wav";
import { InputEventRecorder, type RecordedEvent } from "@/lib/events";

export type Take = {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
  events: RecordedEvent[];
};

export type RecorderStatus = "idle" | "requesting" | "recording" | "processing";

export type RecorderState = {
  status: RecorderStatus;
  elapsed: number;
  level: number;
  peak: number;
  events: RecordedEvent[];
  livePeaks: PeakBucket[];
};

const INITIAL: RecorderState = {
  status: "idle",
  elapsed: 0,
  level: 0,
  peak: 0,
  events: [],
  livePeaks: [],
};

/**
 * Owns a single recording take: microphone PCM, mouse/keyboard events and the
 * live visualisation data shown while recording.
 */
export function useSessionRecorder() {
  const [state, setState] = useState<RecorderState>(INITIAL);
  const [take, setTake] = useState<Take | null>(null);

  const micRef = useRef<MicCapture | null>(null);
  const eventsRef = useRef<InputEventRecorder | null>(null);
  const liveRef = useRef<PeakBucket[]>([]);
  const pendingRef = useRef<Float32Array>(new Float32Array(0));
  const bucketRef = useRef(256);
  const startedAtRef = useRef(0);
  const meterRef = useRef({ level: 0, peak: 0 });
  const frameRef = useRef(0);
  const dirtyRef = useRef(false);
  const statusRef = useRef<RecorderStatus>("idle");
  /** Seconds from the start of the take where the stop click was heard. */
  const trimRef = useRef<number | null>(null);

  const setStatus = useCallback((status: RecorderStatus) => {
    statusRef.current = status;
    setState((prev) => ({ ...prev, status }));
  }, []);

  const tick = useCallback(() => {
    const elapsed = (performance.now() - startedAtRef.current) / 1000;
    const { level, peak } = meterRef.current;
    setState((prev) =>
      prev.status === "recording"
        ? { ...prev, elapsed, level, peak, livePeaks: dirtyRef.current ? liveRef.current : prev.livePeaks }
        : prev,
    );
    dirtyRef.current = false;
  }, []);

  const handleChunk = useCallback((chunk: Float32Array) => {
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i];
      sumSquares += v * v;
      const abs = v < 0 ? -v : v;
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, chunk.length));
    const meter = meterRef.current;
    // Fast attack, slow release reads much better on a level meter.
    meter.level = rms > meter.level ? rms : meter.level * 0.82 + rms * 0.18;
    meter.peak = Math.max(meter.peak * 0.95, peak);

    const pending = pendingRef.current;
    const merged = new Float32Array(pending.length + chunk.length);
    merged.set(pending, 0);
    merged.set(chunk, pending.length);

    const size = bucketRef.current;
    const usable = Math.floor(merged.length / size) * size;
    if (usable > 0) {
      const peaks = computePeaks(merged.subarray(0, usable), usable / size);
      for (const bucket of peaks) liveRef.current.push(bucket);
      pendingRef.current = merged.slice(usable);
    } else {
      pendingRef.current = merged;
    }
    dirtyRef.current = true;
  }, []);

  const reset = useCallback(() => {
    liveRef.current = [];
    pendingRef.current = new Float32Array(0);
    meterRef.current = { level: 0, peak: 0 };
    statusRef.current = "idle";
    trimRef.current = null;
    setState(INITIAL);
  }, []);

  /**
   * Call on the pointer-down of the stop button. The click that ends the take
   * produces exactly the sound this app is trying to capture, so everything it
   * adds to the audio gets cut back out of the finished take.
   */
  const markStopClick = useCallback(() => {
    if (statusRef.current !== "recording") return;
    trimRef.current = (performance.now() - startedAtRef.current) / 1000;
  }, []);

  const start = useCallback(async () => {
    if (statusRef.current !== "idle") return;
    setStatus("requesting");
    reset();
    setStatus("requesting");

    const mic = new MicCapture({ onChunk: handleChunk });
    try {
      await mic.start();
      await player.resume();
    } catch (error) {
      await mic.stop().catch(() => {});
      statusRef.current = "idle";
      setState(INITIAL);
      const message =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow the microphone permission and try again."
          : error instanceof Error
            ? error.message
            : "Could not start recording.";
      toast.error("Recording failed", { description: message });
      return;
    }

    micRef.current = mic;
    bucketRef.current = Math.max(64, Math.round((mic.sampleRate || TARGET_SAMPLE_RATE) * 0.004));

    eventsRef.current = new InputEventRecorder((event) => {
      setState((prev) =>
        prev.status === "recording" ? { ...prev, events: [...prev.events, event] } : prev,
      );
    });

    startedAtRef.current = performance.now();
    eventsRef.current.start();
    statusRef.current = "recording";
    setState({ ...INITIAL, status: "recording" });
    dirtyRef.current = true;

    frameRef.current = requestAnimationFrame(function loop() {
      tick();
      frameRef.current = requestAnimationFrame(loop);
    });
  }, [handleChunk, reset, setStatus, tick]);

  const stop = useCallback(async () => {
    if (statusRef.current !== "recording") return null;
    cancelAnimationFrame(frameRef.current);
    statusRef.current = "processing";
    setState((prev) => ({ ...prev, status: "processing" }));

    const recorded = eventsRef.current?.stop() ?? [];
    const mic = micRef.current;
    const raw = mic?.take() ?? new Float32Array(0);
    const micRate = mic?.sampleRate || TARGET_SAMPLE_RATE;
    await mic?.stop();
    micRef.current = null;
    eventsRef.current = null;

    const resampled = resample(raw, micRate, TARGET_SAMPLE_RATE);
    let samples = resampled;
    let events = recorded;

    // Cut the stop click out of the take. It is an artefact of ending the
    // recording, not part of the performance, and the mic was still running
    // while it happened. Only trust the mark when the stop really followed it,
    // so a press that was dragged off the button cannot eat real audio later.
    const marked = trimRef.current;
    trimRef.current = null;
    const stopAt = (performance.now() - startedAtRef.current) / 1000;
    if (marked !== null && marked > 0 && stopAt - marked < 1) {
      events = recorded.filter((event) => event.time < marked);
      const cut = Math.round(marked * TARGET_SAMPLE_RATE);
      if (cut < samples.length) {
        const trimmed = samples.slice(0, cut);
        // Slicing can leave a step between the last two samples, which pops on
        // playback. Fade the tail out over a few milliseconds.
        const fade = Math.min(trimmed.length, Math.round(0.005 * TARGET_SAMPLE_RATE));
        for (let i = 0; i < fade; i++) {
          trimmed[trimmed.length - fade + i] *= (i + 1) / fade;
        }
        samples = trimmed;
      }
    }

    const next: Take = {
      samples,
      sampleRate: TARGET_SAMPLE_RATE,
      duration: samples.length / TARGET_SAMPLE_RATE,
      events,
    };
    statusRef.current = "idle";
    setTake(next);
    setState((prev) => ({
      ...prev,
      status: "idle",
      events,
      livePeaks: liveRef.current,
      level: 0,
      peak: 0,
    }));
    return next;
  }, []);

  const discard = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    player.stop();
    liveRef.current = [];
    pendingRef.current = new Float32Array(0);
    meterRef.current = { level: 0, peak: 0 };
    statusRef.current = "idle";
    trimRef.current = null;
    setState(INITIAL);
    setTake(null);
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(frameRef.current);
      eventsRef.current?.stop();
      void micRef.current?.stop();
    },
    [],
  );

  return { state, take, setTake, start, stop, discard, markStopClick };
}
