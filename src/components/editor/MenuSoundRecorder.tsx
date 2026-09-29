import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { MicCapture } from "@/lib/audio/mic";
import { player } from "@/lib/audio/player";
import { resample, TARGET_SAMPLE_RATE } from "@/lib/audio/wav";
import {
  MENU_CATEGORIES,
  MENU_CATEGORY_MAP,
  cutMenuStep,
  isTypingKey,
  type MenuCaptureEvent,
  type MenuSoundId,
} from "@/lib/menusounds";
import { cn } from "@/lib/utils";

/**
 * Gap between two samples of the same kind. A worn switch reports one physical
 * press twice a few microseconds apart, and a held key autorepeats; without this
 * the same sound is banked three or four times and the pool is thinner than the
 * counter claims.
 */
const MIN_GAP = 0.12;

type Status = "idle" | "requesting" | "recording" | "cutting";

type RecorderProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  counts: Record<MenuSoundId, number>;
  onRecorded: (category: MenuSoundId, cuts: ReturnType<typeof cutMenuStep>) => Promise<number>;
};

export function MenuSoundRecorder({ open, onOpenChange, counts, onRecorded }: RecorderProps) {
  const [step, setStep] = useState<MenuSoundId>("escape");
  const [status, setStatus] = useState<Status>("idle");
  const [captured, setCaptured] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [typing, setTyping] = useState("");

  const panelRef = useRef<HTMLDivElement | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const eventsRef = useRef<MenuCaptureEvent[]>([]);
  const startedAtRef = useRef(0);
  const rafRef = useRef(0);
  const statusRef = useRef<Status>("idle");
  const stepRef = useRef<MenuSoundId>(step);
  const lastGapRef = useRef(-Infinity);

  const definition = MENU_CATEGORY_MAP[step];
  const have = counts[step] ?? 0;
  const met = have >= definition.target;

  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  const stopAll = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    void micRef.current?.stop();
    micRef.current = null;
  }, []);

  useEffect(() => () => stopAll(), [stopAll]);

  useEffect(() => {
    if (!open) {
      stopAll();
      statusRef.current = "idle";
      setStatus("idle");
      setCaptured(0);
      setElapsed(0);
    }
  }, [open, stopAll]);

  const elapsedNow = () => (performance.now() - startedAtRef.current) / 1000;

  const pushEvent = useCallback((label: string) => {
    const time = elapsedNow();
    if (time - lastGapRef.current < MIN_GAP) return;
    lastGapRef.current = time;
    eventsRef.current.push({ time, label });
    setCaptured(eventsRef.current.length);
  }, []);

  // --- input capture, one rule per kind ---
  // The three kinds are told apart by what the player is being asked to do, not
  // by guessing later: Escape is a keypress of its own, a menu click is a
  // mousedown anywhere outside this window, and typing is a keydown in the box
  // below. Typing is deliberately *not* filtered by input target the way the
  // gameplay recorder filters it - typing into a field is the case being
  // recorded.
  useEffect(() => {
    if (status !== "recording") return;

    const onKeyDown = (event: KeyboardEvent) => {
      const kind = stepRef.current;
      if (event.repeat) return;
      if (kind === "escape") {
        if (event.key !== "Escape") return;
        pushEvent("Esc");
        return;
      }
      if (kind === "typing") {
        const target = event.target as HTMLElement | null;
        if (!target?.dataset?.menuTyping) return;
        if (!isTypingKey(event.key)) return;
        pushEvent(event.key);
      }
    };

    const onMouseDown = (event: MouseEvent) => {
      if (stepRef.current !== "menuclicks") return;
      if (event.button > 4) return;
      // Clicks anywhere in this window are the recorder's own controls, not menu
      // clicks. `panelRef` is the dialog itself, so the backdrop still counts.
      const target = event.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      pushEvent(`Mouse ${event.button}`);
    };

    const onContextMenu = (event: MouseEvent) => {
      if (stepRef.current === "menuclicks") event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
    };
  }, [status, pushEvent]);

  const start = async () => {
    if (statusRef.current !== "idle") return;
    setStatus("requesting");
    const mic = new MicCapture({ onChunk: () => {} });
    try {
      await mic.start();
      await player.resume();
    } catch (error) {
      await mic.stop().catch(() => {});
      setStatus("idle");
      toast.error("Could not start recording", {
        description:
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "Microphone permission was blocked."
            : "The microphone is unavailable right now.",
      });
      return;
    }

    micRef.current = mic;
    eventsRef.current = [];
    lastGapRef.current = -Infinity;
    setCaptured(0);
    setElapsed(0);
    startedAtRef.current = performance.now();
    statusRef.current = "recording";
    setStatus("recording");

    const tick = () => {
      setElapsed(elapsedNow());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const stop = async () => {
    if (statusRef.current !== "recording") return;
    cancelAnimationFrame(rafRef.current);
    statusRef.current = "cutting";
    setStatus("cutting");

    const events = eventsRef.current;
    const mic = micRef.current;
    const raw = mic?.take() ?? new Float32Array(0);
    const micRate = mic?.sampleRate || TARGET_SAMPLE_RATE;
    await mic?.stop();
    micRef.current = null;

    const samples = resample(raw, micRate, TARGET_SAMPLE_RATE);
    const cuts = cutMenuStep(samples, TARGET_SAMPLE_RATE, events, definition);

    if (cuts.length === 0) {
      setStatus("idle");
      setCaptured(0);
      toast.error("Nothing usable was captured", {
        description: "The sounds were too quiet, or the room was louder than the action.",
      });
      return;
    }

    const saved = await onRecorded(step, cuts);
    if (saved === 0) {
      setStatus("idle");
      return;
    }
    setStatus("idle");
    setCaptured(0);
    setElapsed(0);
    toast.success(`${definition.label}: ${saved} clip${saved === 1 ? "" : "s"} saved`, {
      description:
        saved >= definition.target
          ? "Target reached. Record again to replace them, or move on."
          : `${definition.target - saved} short of the target. Record again to top it up.`,
    });
  };

  const recording = status === "recording";
  const busy = status === "requesting" || status === "cutting";

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      {/*
        The ref goes on the whole dialog, not just the step list. Anything the
        player clicks inside this window is the recorder's own UI, and the
        controls that matter are the ones outside the list: pressing "Stop and
        save" used to bank its own mousedown as a menu click, so every
        menu-click take ended with one fake sample in it.
      */}
      <DialogContent
        ref={panelRef}
        className="gap-0 p-0 sm:max-w-xl"
        onEscapeKeyDown={(event) => {
          // Escape is itself a sample on the first step, and on the other two a
          // stray Escape mid-take would silently throw the recording away. Stop
          // and save is the only way out while recording.
          if (recording) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          // The prompt tells the player to click anywhere outside this window,
          // and the dimmed backdrop is the largest place to do that - but it
          // must not also dismiss the dialog and lose the take.
          if (recording) event.preventDefault();
        }}
      >
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>Record menu sounds</DialogTitle>
          <DialogDescription>
            Three short steps. ZCB plays Escape from anywhere, menu clicks only outside a level, and
            typing only while you are actually typing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-6 py-5">
          <div className="space-y-2" role="tablist" aria-label="Menu sound steps">
            {MENU_CATEGORIES.map((category) => {
              const count = counts[category.id] ?? 0;
              const active = category.id === step;
              const enough = count >= category.target;
              return (
                <button
                  key={category.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  disabled={recording || busy}
                  onClick={() => setStep(category.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                    "outline-none focus-visible:ring-ring/40 focus-visible:ring-[3px]",
                    "disabled:pointer-events-none disabled:opacity-60",
                    active
                      ? "border-primary bg-accent"
                      : "border-border bg-background hover:bg-accent/50",
                  )}
                >
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium">{category.label}</span>
                    <span className="block text-xs text-muted-foreground">{category.prompt}</span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-xs tabular-nums",
                      enough ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {count} / {category.target}
                    {enough ? " ✓" : ""}
                  </span>
                </button>
              );
            })}
          </div>

          <Separator />

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{definition.hint}</p>

            {step === "typing" && (
              <div className="space-y-1.5">
                <Label htmlFor="menu-typing" className="text-xs text-muted-foreground">
                  Type here
                </Label>
                <Input
                  id="menu-typing"
                  data-menu-typing="true"
                  value={typing}
                  readOnly={!recording}
                  placeholder={recording ? "" : "Start the step, then click here and type."}
                  onChange={(event) => setTyping(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}

            {recording && (
              <div className="space-y-1.5">
                <Progress
                  value={Math.min(100, (captured / definition.target) * 100)}
                  aria-label={`Recording ${definition.label}`}
                  aria-valuetext={`${captured} captured`}
                />
                <p className="text-xs text-muted-foreground tabular-nums">
                  {captured} captured · {elapsed.toFixed(1)}s · target {definition.target}
                  {met ? " (already have enough - keep going for more)" : ""}
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {recording ? (
                <Button variant="destructive" onClick={() => void stop()}>
                  Stop and save
                </Button>
              ) : (
                <Button onClick={() => void start()} disabled={busy} variant="outline">
                  {status === "cutting" ? "Cutting…" : have > 0 ? "Re-record" : "Start"}
                </Button>
              )}
              {recording && (
                <span className="text-xs text-muted-foreground">
                  Press stop whenever you have enough. Recording past the target is fine.
                </span>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy || recording}>
            {met ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
