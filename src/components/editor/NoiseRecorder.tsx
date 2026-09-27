import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { MicCapture } from "@/lib/audio/mic";
import { player } from "@/lib/audio/player";
import { encodeWav, formatSeconds, resample, TARGET_SAMPLE_RATE } from "@/lib/audio/wav";
import type { StoredNoise } from "@/lib/store";

export const MAX_NOISE_SECONDS = 60;
export const MIN_NOISE_SECONDS = 1;

type NoiseRecorderProps = {
  noise: StoredNoise | null;
  onChange: (noise: StoredNoise | null) => void;
};

type Status = "idle" | "recording" | "encoding" | "playing";

export function NoiseRecorder({ noise, onChange }: NoiseRecorderProps) {
  const [lengthInput, setLengthInput] = useState("5");
  const [status, setStatus] = useState<Status>("idle");
  const [elapsed, setElapsed] = useState(0);
  const micRef = useRef<MicCapture | null>(null);
  const rafRef = useRef(0);
  const startedAtRef = useRef(0);

  const target = Math.min(
    MAX_NOISE_SECONDS,
    Math.max(MIN_NOISE_SECONDS, Math.round(Number(lengthInput) || MIN_NOISE_SECONDS)),
  );

  useEffect(() => () => stopAll(), []);

  function stopAll() {
    cancelAnimationFrame(rafRef.current);
    void micRef.current?.stop();
    micRef.current = null;
  }

  const startRecording = async () => {
    setStatus("recording");
    setElapsed(0);
    const mic = new MicCapture({ onChunk: () => {} });
    try {
      await mic.start();
      await player.resume();
    } catch (error) {
      setStatus("idle");
      toast.error("Could not record the noise bed", {
        description:
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "Microphone permission was blocked."
            : "The microphone is unavailable right now.",
      });
      return;
    }

    micRef.current = mic;
    startedAtRef.current = performance.now();

    await new Promise<void>((resolve) => {
      const loop = () => {
        const seconds = (performance.now() - startedAtRef.current) / 1000;
        setElapsed(seconds);
        if (seconds >= target) {
          resolve();
          return;
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    });

    const raw = mic.take();
    const rate = mic.sampleRate || TARGET_SAMPLE_RATE;
    await mic.stop();
    micRef.current = null;
    cancelAnimationFrame(rafRef.current);
    setStatus("encoding");

    const samples = resample(raw, rate, TARGET_SAMPLE_RATE);
    if (samples.length < TARGET_SAMPLE_RATE * 0.1) {
      setStatus("idle");
      toast.error("That recording was too short", { description: "Try again for a second or two." });
      return;
    }

    const wav = encodeWav(samples, TARGET_SAMPLE_RATE).buffer as ArrayBuffer;
    const next: StoredNoise = { wav, duration: samples.length / TARGET_SAMPLE_RATE, createdAt: Date.now() };
    onChange(next);
    setStatus("idle");
    setElapsed(0);
    toast.success("Noise bed ready", {
      description: `${formatSeconds(next.duration, 2)} saved as noise.wav`,
    });
  };

  const stopEarly = async () => {
    if (status !== "recording") return;
    cancelAnimationFrame(rafRef.current);
    const mic = micRef.current;
    if (!mic) return;
    const raw = mic.take();
    const rate = mic.sampleRate || TARGET_SAMPLE_RATE;
    await mic.stop();
    micRef.current = null;

    const samples = resample(raw, rate, TARGET_SAMPLE_RATE);
    if (samples.length < TARGET_SAMPLE_RATE * 0.1) {
      setStatus("idle");
      setElapsed(0);
      toast.error("That recording was too short");
      return;
    }
    const wav = encodeWav(samples, TARGET_SAMPLE_RATE).buffer as ArrayBuffer;
    onChange({ wav, duration: samples.length / TARGET_SAMPLE_RATE, createdAt: Date.now() });
    setStatus("idle");
    setElapsed(0);
  };

  const togglePlay = async () => {
    if (!noise) return;
    if (status === "playing") {
      player.stop();
      setStatus("idle");
      return;
    }
    setStatus("playing");
    try {
      await player.playWav(noise.wav);
    } catch {
      /* ignored */
    }
    setStatus("idle");
  };

  return (
      <div className="space-y-3 rounded-lg border border-border bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Clickpack Noise File</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Optional room tone exported as noise.wav at the pack root. Up to {MAX_NOISE_SECONDS}{" "}
            seconds.
          </p>
        </div>
        {noise && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatSeconds(noise.duration, 2)}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-32 space-y-1.5">
          <Label htmlFor="noise-length" className="text-xs text-muted-foreground">
            Length (seconds)
          </Label>
          <Input
            id="noise-length"
            type="number"
            inputMode="numeric"
            min={MIN_NOISE_SECONDS}
            max={MAX_NOISE_SECONDS}
            value={lengthInput}
            disabled={status === "recording"}
            onChange={(event) => setLengthInput(event.target.value)}
          />
        </div>

        <div className="flex items-center gap-2">
          {status === "recording" ? (
            <Button variant="destructive" onClick={stopEarly}>
              Stop · {Math.max(0, target - elapsed).toFixed(1)}s left
            </Button>
          ) : (
            <Button
              onClick={startRecording}
              disabled={status === "encoding"}
              variant={noise ? "outline" : "default"}
            >
              {status === "encoding" ? "Encoding…" : noise ? "Re-record" : `Record ${target}s`}
            </Button>
          )}

          <Button
            variant="outline"
            onClick={togglePlay}
            disabled={!noise || status === "recording"}
          >
            {status === "playing" ? "Pause" : "Preview"}
          </Button>

          <Button
            variant="ghost"
            disabled={!noise || status === "recording"}
            onClick={() => {
              player.stop();
              onChange(null);
              setStatus("idle");
            }}
          >
            Remove
          </Button>
        </div>
      </div>

      {status === "recording" && (
        <div className="space-y-1.5">
          <Progress value={(elapsed / target) * 100} className="h-1.5" />
          <p className="text-xs text-muted-foreground">
            recording {elapsed.toFixed(1)}s / {target}s - keep the room quiet
          </p>
        </div>
      )}

      {status !== "recording" && noise && (
        <p className="text-xs text-muted-foreground">
          {noise.duration.toFixed(2)}s · 48 kHz · 16-bit mono ·{" "}
          {(noise.wav.byteLength / 1024).toFixed(0)} KB
        </p>
      )}
    </div>
  );
}
