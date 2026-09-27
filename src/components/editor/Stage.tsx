import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { formatTimestamp } from "@/lib/audio/wav";
import { cn } from "@/lib/utils";
import { Mic } from "lucide-react";

type StageProps = {
  elapsed: number;
  level: number;
  peak: number;
  presses: number;
  releases: number;
  onStop: () => void;
  onStopPress: () => void;
  cancelling: boolean;
};

const LEVEL_BARS = 28;

export function Stage({
  elapsed,
  level,
  peak,
  presses,
  releases,
  onStop,
  onStopPress,
  cancelling,
}: StageProps) {
  const smoothingRef = useRef<number[]>(new Array(LEVEL_BARS).fill(0));

  const target = Math.min(1, Math.max(0, level) * 2.6);
  const bars = smoothingRef.current.map((value, index) => {
    const weight = 0.45 + (index / LEVEL_BARS) * 0.85;
    const desired = Math.min(1, target * weight);
    const next = desired > value ? desired : value * 0.86 + desired * 0.14;
    smoothingRef.current[index] = next;
    return next;
  });

  const clipping = peak > 0.985;

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-8 bg-background px-6">
      <div className="relative flex flex-col items-center gap-3 text-center">
        <p className="text-sm font-medium text-destructive">Recording</p>
        <p
          role="timer"
          aria-label="Elapsed"
          className="font-mono text-5xl font-medium tracking-tight tabular-nums sm:text-6xl"
        >
          {formatTimestamp(elapsed)}
        </p>
        <p className="max-w-md text-sm text-muted-foreground text-pretty">
          Click your mouse and tap your keys as usual. Press Esc or the stop button when you are
          done.
        </p>
      </div>

      <div className="relative w-full max-w-xl">
        <div
          className={cn(
            "flex h-28 items-center justify-center gap-1.5 rounded-lg border-2 border-dashed bg-card px-6 transition-colors",
            clipping ? "border-destructive" : "border-border",
          )}
        >
          {bars.map((value, index) => (
            <div
              key={index}
              className={cn(
                "w-full max-w-3 rounded-full transition-[height,background-color] duration-75",
                clipping ? "bg-destructive" : value > 0.86 ? "bg-chart-3" : "bg-brand",
              )}
              style={{ height: `${Math.max(3, value * 100)}%` }}
            />
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between font-mono text-[0.65rem] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Mic className="size-3" />
            {clipping ? "Clipping - pull back from the mic" : "Input level"}
          </span>
          <span>{clipping ? "HOT" : `${Math.round(peak * 100)}% peak`}</span>
        </div>
      </div>

      <p className="relative text-sm text-muted-foreground">
        {presses} press{presses === 1 ? "" : "es"} · {releases} release
        {releases === 1 ? "" : "s"} · keys included
      </p>

      <div className="relative w-full max-w-sm">
        <Button
          size="xl"
          variant="destructive"
          onPointerDown={onStopPress}
          onClick={onStop}
          disabled={cancelling}
          className="w-full"
        >
          {cancelling ? "Processing take…" : "Stop recording"}
        </Button>
      </div>
    </div>
  );
}
