import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ExportDialog } from "@/components/editor/ExportDialog";
import { LibraryPanel } from "@/components/editor/LibraryPanel";
import { SelectionHint, SelectionMenu } from "@/components/editor/SelectionMenu";
import { Stage } from "@/components/editor/Stage";
import {
  WaveformTimeline,
  type Anchor,
  type Selection,
  type ViewWindow,
} from "@/components/editor/WaveformTimeline";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useClickLibrary } from "@/hooks/useClickLibrary";
import { useSessionRecorder } from "@/hooks/useSessionRecorder";
import { player } from "@/lib/audio/player";
import {
  computePeaks,
  cutSegment,
  DEFAULT_CUT_BEHAVIOR,
  SELECTION_CUT_OPTIONS,
  type CutBehavior,
  type PeakBucket,
} from "@/lib/audio/process";
import { encodeWav, formatSeconds, formatTimestamp, TARGET_SAMPLE_RATE } from "@/lib/audio/wav";
import type { AutoCutClip } from "@/lib/audio/autocut";
import { CATEGORY_MAP, type CategoryId, type StoredSound } from "@/lib/types";
import { ZCB_CUT_PRESET } from "@/lib/zcb";
import { cn } from "@/lib/utils";

const LIVE_WINDOW = 20;
const MAX_PEAKS = 90000;

type EditorProps = {
  onExit: () => void;
};

export function Editor({ onExit }: EditorProps) {
  const { state, take, start, stop, discard, markStopClick } = useSessionRecorder();
  const library = useClickLibrary();

  const [selection, setSelection] = useState<Selection | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<ViewWindow>({ start: 0, end: 30 });
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [snap, setSnap] = useState(true);
  const [suggest, setSuggest] = useState(true);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [activeClip, setActiveClip] = useState<string | null>(null);
  /**
   * What to do to a cut on the way out. All off, so a selection is saved exactly
   * as drawn; each extra is opt-in and changes what the audition plays.
   */
  const [cutBehavior, setCutBehavior] = useState<CutBehavior>(DEFAULT_CUT_BEHAVIOR);

  const bufferRef = useRef<AudioBuffer | null>(null);
  const playRafRef = useRef(0);
  const followRef = useRef(true);
  // Bumped on every play/seek/stop so a finished AudioBufferSourceNode from a
  // superseded playback cannot move the playhead.
  const playTokenRef = useRef(0);
  // Set while a cut preview plays, so its buffer-local position can be mapped
  // back onto the timeline.
  const previewRef = useRef<{ from: number; length: number } | null>(null);

  const recording = state.status === "recording";
  const busy = state.status === "requesting" || state.status === "processing";

  const peaks = useMemo<PeakBucket[]>(() => {
    if (recording) return state.livePeaks;
    if (!take || take.samples.length === 0) return [];
    const count = Math.min(MAX_PEAKS, Math.max(1, Math.floor(take.samples.length / 32)));
    return computePeaks(take.samples, count);
  }, [recording, state.livePeaks, take]);

  const liveDuration = state.livePeaks.length * 0.004;
  const duration = recording ? liveDuration : (take?.duration ?? 0);
  const events = useMemo(
    () => (recording ? state.events : (take?.events ?? [])),
    [recording, state.events, take],
  );
  const pressCount = useMemo(() => events.filter((event) => event.kind === "press").length, [events]);
  const releaseCount = events.length - pressCount;

  const savedMarkers = useMemo<Selection[]>(
    () =>
      take
        ? library.sounds.map((sound) => ({ start: sound.sourceStart, end: sound.sourceEnd }))
        : [],
    [library.sounds, take],
  );

  // Follow the growing waveform while recording, then fit the finished take.
  useEffect(() => {
    if (recording) {
      setView((prev) => {
        const span = Math.max(prev.end - prev.start, LIVE_WINDOW);
        const end = Math.max(span, liveDuration);
        const start = Math.max(0, end - span);
        return prev.start === start && prev.end === end ? prev : { start, end };
      });
      return;
    }
    if (!take || !followRef.current) return;
    setView({ start: 0, end: Math.max(6, take.duration * 1.02) });
  }, [recording, liveDuration, take]);

  // Cache the decoded take so it can be auditioned later.
  useEffect(() => {
    if (!take || take.samples.length === 0) {
      bufferRef.current = null;
      return;
    }
    let cancelled = false;
    const buffer = player.createBuffer(take.samples, take.sampleRate);
    if (!cancelled) bufferRef.current = buffer;
    return () => {
      cancelled = true;
    };
  }, [take]);

  useEffect(
    () => () => {
      cancelAnimationFrame(playRafRef.current);
      player.stop();
    },
    [],
  );

  const stopPlayback = useCallback(() => {
    playTokenRef.current++;
    previewRef.current = null;
    cancelAnimationFrame(playRafRef.current);
    player.stop();
    setPlaying(false);
  }, []);

  const playFrom = useCallback((offset: number) => {
    const buffer = bufferRef.current;
    if (!buffer) return;
    playTokenRef.current++;
    const token = playTokenRef.current;
    previewRef.current = null;
    player.stop();
    setPlaying(true);
    void player.play(buffer, offset).then(() => {
      // A pause or seek resolves this same promise. Only the playback that is
      // still current may touch state, otherwise pausing snaps back to 0.
      if (playTokenRef.current !== token) return;
      cancelAnimationFrame(playRafRef.current);
      setPlaying(false);
      setPlayhead(buffer.duration);
    });

    let last = 0;
    const loop = (now: number) => {
      if (playTokenRef.current !== token) return;
      if (now - last > 40) {
        last = now;
        setPlayhead(player.position);
      }
      playRafRef.current = requestAnimationFrame(loop);
    };
    playRafRef.current = requestAnimationFrame(loop);
  }, []);

  const togglePlay = useCallback(() => {
    const preview = previewRef.current;
    if (playing) {
      const position = player.position;
      // A cut preview plays an isolated buffer, so its position is relative to
      // the cut. Map it back onto the timeline before parking the playhead.
      const mapped = preview ? preview.from + Math.min(position, preview.length) : position;
      stopPlayback();
      setPlayhead(mapped);
      return;
    }
    playFrom(playhead >= (take?.duration ?? 0) ? 0 : playhead);
  }, [playing, playhead, take, playFrom, stopPlayback]);

  const handleSeek = useCallback(
    (time: number) => {
      followRef.current = false;
      setPlayhead(time);
      if (playing) playFrom(time);
    },
    [playing, playFrom],
  );

  const handleSelect = useCallback((next: Selection | null, nextAnchor: Anchor | null) => {
    setSelection(next);
    setAnchor(nextAnchor);
  }, []);

  const selectNext = useCallback(
    (after: number) => {
      if (!take) return;
      const next = events.find((event) => event.time > after + 0.02);
      if (!next) {
        setSelection(null);
        setAnchor(null);
        return;
      }
      setSelection({
        start: Math.max(0, next.time - 0.004),
        end: Math.min(take.duration, next.time + 0.3),
      });
      setAnchor(null);
    },
    [events, take],
  );

  const buildCut = useCallback(
    (value: Selection) => {
      if (!take) return null;
      return cutSegment(take.samples, take.sampleRate, value.start, value.end, {
        ...SELECTION_CUT_OPTIONS,
        sampleRate: TARGET_SAMPLE_RATE,
        ...cutBehavior,
      });
    },
    [cutBehavior, take],
  );


  const handleSave = useCallback(
    async (category: CategoryId) => {
      const value = selection;
      setMenuOpen(false);
      if (!value || !take) return;

      const cut = buildCut(value);
      if (!cut || cut.samples.length === 0) {
        toast.error("Nothing to cut there", {
          description: "That region is silent - drag across a click you can hear.",
        });
        return;
      }

      const label = CATEGORY_MAP[category].label;
      const wav = encodeWav(cut.samples, TARGET_SAMPLE_RATE);
      const sound: StoredSound = {
        id: `${category}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        category,
        name: `${label} ${library.nextIndex(category)}`,
        sourceStart: cut.start,
        sourceEnd: cut.end,
        duration: cut.samples.length / TARGET_SAMPLE_RATE,
        peak: cut.peakBefore,
        gain: cut.gain,
        createdAt: Date.now(),
        wav: wav.buffer as ArrayBuffer,
      };

      if (!(await library.add(sound))) return;

      setActiveClip(sound.id);
      const gainText =
        cut.gain > 1.005 ? `normalised +${(20 * Math.log10(cut.gain)).toFixed(1)} dB` : "no gain applied";
      toast.success(`Saved as ${label}`, {
        description: `${formatSeconds(sound.duration, 3)} · ${sound.name}.wav · ${gainText}`,
      });

      if (autoAdvance) selectNext(value.end);
    },
    [autoAdvance, buildCut, library, selectNext, selection, take],
  );

  /**
   * Persists a full Autocut run. `library.nextIndex` cannot be used here because
   * the library state only lands after a render, so each category is counted as
   * the clips go in.
   */
  const handleAutocutSave = useCallback(
    async (clips: AutoCutClip[]) => {
      const counters = new Map<CategoryId, number>();
      let allSaved = true;

      for (const clip of clips) {
        const next = (counters.get(clip.category) ?? 0) + 1;
        counters.set(clip.category, next);

        const label = CATEGORY_MAP[clip.category].label;
        const wav = encodeWav(clip.cut.samples, TARGET_SAMPLE_RATE);
        const sound: StoredSound = {
          id: `${clip.category}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          category: clip.category,
          name: `${label} ${next}`,
          sourceStart: clip.cut.start,
          sourceEnd: clip.cut.end,
          duration: clip.cut.samples.length / TARGET_SAMPLE_RATE,
          peak: clip.cut.peakBefore,
          gain: clip.cut.gain,
          createdAt: Date.now(),
          wav: wav.buffer as ArrayBuffer,
        };
        if (!(await library.add(sound))) allSaved = false;
      }

      return allSaved;
    },
    [library],
  );

  const handlePreviewCut = useCallback(() => {
    if (!selection) return;
    const takeBuffer = bufferRef.current;
    if (!takeBuffer) return;
    // Audition the clip that would actually be saved, not the raw region, so
    // what you hear is what lands in the zip. The cut honours the toggles, so
    // snapping, trimming, normalising and fading all change what you hear.
    const cut = buildCut(selection);
    if (!cut || cut.samples.length === 0) {
      toast.error("Nothing to preview", { description: "That selection is empty." });
      return;
    }

    const from = cut.start;
    const length = cut.samples.length / TARGET_SAMPLE_RATE;

    stopPlayback();
    const token = playTokenRef.current;
    previewRef.current = { from, length };

    const buffer = player.createBuffer(cut.samples, TARGET_SAMPLE_RATE);
    setPlayhead(from);
    setPlaying(true);
    void player.play(buffer, 0).then(() => {
      if (playTokenRef.current !== token) return;
      cancelAnimationFrame(playRafRef.current);
      setPlaying(false);
      setPlayhead(from + length);
    });

    // The preview plays the clip on its own, so walk the playhead across it
    // instead of leaving it parked at the start.
    let last = 0;
    const loop = (now: number) => {
      if (playTokenRef.current !== token) return;
      if (now - last > 40) {
        last = now;
        setPlayhead(from + Math.min(player.position, length));
      }
      playRafRef.current = requestAnimationFrame(loop);
    };
    playRafRef.current = requestAnimationFrame(loop);
  }, [buildCut, selection, stopPlayback]);

  const handleRecord = useCallback(async () => {
    if (recording) {
      await stop();
      return;
    }
    followRef.current = true;
    setSelection(null);
    setAnchor(null);
    setMenuOpen(false);
    stopPlayback();
    await start();
  }, [recording, start, stop, stopPlayback]);

  const handleNewTake = useCallback(() => {
    stopPlayback();
    discard();
    setSelection(null);
    setAnchor(null);
    setPlayhead(0);
    setView({ start: 0, end: 30 });
    followRef.current = true;
  }, [discard, stopPlayback]);

  const fitView = useCallback(() => {
    if (!take) return;
    followRef.current = true;
    setView({ start: 0, end: Math.max(6, take.duration * 1.02) });
  }, [take]);

  const zoom = useCallback(
    (factor: number) => {
      if (!duration) return;
      followRef.current = false;
      setView((prev) => {
        const current = prev.end - prev.start;
        const span = Math.max(0.04, Math.min(duration, current * factor));
        const center = prev.start + current / 2;
        const start = Math.max(0, Math.min(duration - span, center - span / 2));
        return { start, end: start + span };
      });
    },
    [duration],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (recording && event.key === "Escape") {
        event.preventDefault();
        void stop();
        return;
      }
      if (typing || menuOpen || exportOpen) return;

      const key = event.key.toLowerCase();
      if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
      } else if (key === "r" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        void handleRecord();
      } else if ((event.key === "Delete" || event.key === "Backspace") && selection) {
        event.preventDefault();
        setSelection(null);
        setAnchor(null);
      } else if (event.key === "Enter" && selection && selection.end > selection.start) {
        event.preventDefault();
        if (anchor) setMenuOpen(true);
      } else if ((event.metaKey || event.ctrlKey) && key === "e") {
        event.preventDefault();
        setExportOpen(true);
      } else if (event.key === "+" || event.key === "=") {
        zoom(0.6);
      } else if (event.key === "-") {
        zoom(1.6);
      } else if (event.key === "0") {
        fitView();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [anchor, exportOpen, fitView, handleRecord, menuOpen, recording, selection, stop, togglePlay, zoom]);

  const hasSelection = !!selection && selection.end - selection.start > 0.005;
  const cutInfo = hasSelection ? buildCut(selection!) : null;
  // With every extra off the cut *is* the selection, so only report a separate
  // length when something actually changed it.
  const trimmedSeconds = cutInfo ? cutInfo.samples.length / TARGET_SAMPLE_RATE : null;
  const cutDuration =
    trimmedSeconds !== null && hasSelection && Math.abs(trimmedSeconds - (selection!.end - selection!.start)) > 0.0005
      ? trimmedSeconds
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <EditorTopbar
        onExit={onExit}
        recording={recording}
        busy={busy}
        hasTake={!!take}
        duration={duration}
        total={library.total}
        onRecord={handleRecord}
        onNewTake={handleNewTake}
        onExport={() => setExportOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <TimelineToolbar
            view={view}
            snap={snap}
            suggest={suggest}
            autoAdvance={autoAdvance}
            hoverTime={hoverTime}
            pressCount={pressCount}
            releaseCount={releaseCount}
            disabled={recording || !take}
            onSnapChange={setSnap}
            onSuggestChange={setSuggest}
            onAutoAdvanceChange={setAutoAdvance}
            onZoom={zoom}
            onFit={fitView}
          />

          <div className="relative min-h-0 flex-1">
            <WaveformTimeline
              className="absolute inset-0"
              peaks={peaks}
              duration={duration}
              events={events}
              selection={selection}
              playhead={playhead}
              view={view}
              live={recording}
              snap={snap}
              suggest={suggest}
              savedMarkers={savedMarkers}
              onViewChange={(next) => {
                followRef.current = false;
                setView(next);
              }}
              onSeek={handleSeek}
              onSelect={handleSelect}
              onCommitSelect={(next, nextAnchor) => {
                setSelection(next);
                setAnchor(nextAnchor);
                setMenuOpen(true);
              }}
              onHoverTime={setHoverTime}
            />

            {!take && !recording && <EmptyState onRecord={handleRecord} total={library.total} />}

            {recording && (
              <Stage
                elapsed={state.elapsed}
                level={state.level}
                peak={state.peak}
                presses={pressCount}
                releases={releaseCount}
                cancelling={state.status === "processing"}
                onStopPress={markStopClick}
                onStop={() => void stop()}
              />
            )}

            <SelectionMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              anchor={menuOpen ? anchor : null}
              duration={hasSelection && selection ? selection.end - selection.start : 0}
              counts={library.counts}
              onPreview={handlePreviewCut}
              onSave={(category) => void handleSave(category)}
              onDiscard={() => {
                setSelection(null);
                setAnchor(null);
              }}
            />
          </div>

          <div className="flex h-9 shrink-0 items-center border-t border-border px-4">
            {take ? <SelectionHint /> : <EmptyHint />}
          </div>

          {take && (
            <CutBehaviorRow
              behavior={cutBehavior}
              onChange={(key, value) =>
                setCutBehavior((prev) => ({ ...prev, [key]: value }))
              }
            />
          )}

          <TransportBar
            playing={playing}
            playhead={playhead}
            duration={duration}
            take={!!take}
            selection={hasSelection ? selection : null}
            cutDuration={cutDuration}
            canSave={hasSelection && !!anchor}
            onTogglePlay={togglePlay}
            onStop={() => {
              stopPlayback();
              setPlayhead(0);
            }}
            onOpenMenu={() => anchor && setMenuOpen(true)}
            onNext={() => selection && selectNext(selection.end)}
            onDiscard={() => {
              setSelection(null);
              setAnchor(null);
            }}
          />
        </div>

        <LibraryPanel
          sounds={library.sounds}
          loading={library.loading}
          activeId={activeClip}
          onPreview={(sound) => {
            setActiveClip(sound.id);
            void library.preview(sound);
          }}
          onRemove={(id) => {
            if (activeClip === id) setActiveClip(null);
            void library.remove(id);
          }}
          onClearAll={() => void library.clearAll()}
        />
      </div>

      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        sounds={library.sounds}
        counts={library.counts}
        noise={library.noise}
        onNoiseChange={(value) => void library.setNoiseBed(value)}
        take={take}
        onAutocutSave={handleAutocutSave}
      />
    </div>
  );
}

function EditorTopbar({
  onExit,
  recording,
  busy,
  hasTake,
  duration,
  total,
  onRecord,
  onNewTake,
  onExport,
}: {
  onExit: () => void;
  recording: boolean;
  busy: boolean;
  hasTake: boolean;
  duration: number;
  total: number;
  onRecord: () => void;
  onNewTake: () => void;
  onExport: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3">
      <Button variant="ghost" onClick={onExit} aria-label="Back to the landing page">
        Back
      </Button>

      <p className="hidden text-sm font-semibold tracking-tight sm:block">
        CutIt<span className="italic text-brand">Quik</span>
      </p>

      <Separator orientation="vertical" className="mx-1 h-6" />

      <div className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
        <span className="font-mono tabular-nums">
          {hasTake ? formatSeconds(duration, 2) : "no take"}
        </span>
        <span aria-hidden>·</span>
        <span>{total} saved</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" onClick={onNewTake}>
          New take
        </Button>

        <Button onClick={onRecord} disabled={busy} variant={recording ? "destructive" : "default"}>
          {recording ? "Stop" : busy ? "Working…" : hasTake ? "Record again" : "Record"}
        </Button>

        <Button variant="outline" onClick={onExport}>
          Export
        </Button>
      </div>
    </header>
  );
}

function TimelineToolbar({
  view,
  snap,
  suggest,
  autoAdvance,
  hoverTime,
  pressCount,
  releaseCount,
  disabled,
  onSnapChange,
  onSuggestChange,
  onAutoAdvanceChange,
  onZoom,
  onFit,
}: {
  view: ViewWindow;
  snap: boolean;
  suggest: boolean;
  autoAdvance: boolean;
  hoverTime: number | null;
  pressCount: number;
  releaseCount: number;
  disabled: boolean;
  onSnapChange: (value: boolean) => void;
  onSuggestChange: (value: boolean) => void;
  onAutoAdvanceChange: (value: boolean) => void;
  onZoom: (factor: number) => void;
  onFit: () => void;
}) {
  const span = view.end - view.start;

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onZoom(0.6)}
        disabled={disabled}
        aria-label="Zoom in"
      >
        Zoom in
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => onZoom(1.6)}
        disabled={disabled}
        aria-label="Zoom out"
      >
        Zoom out
      </Button>

      <Button variant="ghost" size="sm" onClick={onFit} disabled={disabled} aria-label="Fit take">
        Fit
      </Button>

      <span className="ml-1 hidden font-mono text-xs text-muted-foreground tabular-nums sm:inline">
        {span >= 1 ? `${span.toFixed(1)}s` : `${(span * 1000).toFixed(0)}ms`}
      </span>

      <Separator orientation="vertical" className="mx-1.5 h-5" />

      <ToggleChip
        active={suggest}
        onClick={() => onSuggestChange(!suggest)}
        label="Suggest Clicks/Releases"
        title="Show where each click and release was detected. Visual only - it never moves your cut."
        disabled={disabled}
      />

      <ToggleChip
        active={snap}
        onClick={() => onSnapChange(!snap)}
        label="Snap"
        title="Pull the cut edges onto the nearest detected click or release."
        disabled={disabled}
      />

      <ToggleChip
        active={autoAdvance}
        onClick={() => onAutoAdvanceChange(!autoAdvance)}
        label="Next cut"
        title="After saving, jump the selection to the next detected click or release."
        disabled={disabled}
      />

      <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          {pressCount} press · {releaseCount} release
        </span>
        <span className="w-20 text-right font-mono tabular-nums">
          {hoverTime === null ? "-" : formatTimestamp(hoverTime).slice(3)}
        </span>
      </div>
    </div>
  );
}

function ToggleChip({
  active,
  onClick,
  label,
  title,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={cn(
        "h-7 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-40",
        active
          ? "bg-brand text-brand-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function TransportBar({
  playing,
  playhead,
  duration,
  take,
  selection,
  cutDuration,
  canSave,
  onTogglePlay,
  onStop,
  onOpenMenu,
  onNext,
  onDiscard,
}: {
  playing: boolean;
  playhead: number;
  duration: number;
  take: boolean;
  selection: Selection | null;
  cutDuration: number | null;
  canSave: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  onOpenMenu: () => void;
  onNext: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-t border-border px-3">
      <Button variant="ghost" size="sm" onClick={onTogglePlay} disabled={!take}>
        {playing ? "Pause" : "Play"}
      </Button>
      <Button variant="ghost" size="sm" onClick={onStop} disabled={!take}>
        Stop
      </Button>

      <div className="font-mono text-xs tabular-nums">
        <span role="timer" aria-label="Playhead" className="text-foreground">
          {formatTimestamp(playhead)}
        </span>
        <span className="text-muted-foreground"> / {formatTimestamp(duration)}</span>
      </div>

      <Separator orientation="vertical" className="h-5" />

      {selection ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 font-mono text-xs tabular-nums">
            {formatSeconds(selection.end - selection.start, 3)} selected
          </span>
          {cutDuration !== null && (
            <span className="truncate text-xs text-muted-foreground">
              {formatSeconds(cutDuration, 3)} after trim
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={onNext} className="text-xs">
              Next
            </Button>
            <Button size="sm" variant="ghost" onClick={onDiscard} className="text-xs">
              Clear
            </Button>
            <Button size="sm" onClick={onOpenMenu} disabled={!canSave}>
              Save selection
            </Button>
          </div>
        </div>
      ) : (
        <p className="flex-1 truncate text-xs text-muted-foreground">
          {take
            ? "Drag across the waveform to select a single click or release."
            : "Record a take to start cutting."}
        </p>
      )}
    </div>
  );
}

/**
 * The opt-in extras applied to a cut, each with a plain explanation on hover.
 * They sit in the editor rather than the export dialog because they change what
 * the audition button plays, and that decision is made while cutting.
 */
const CUT_BEHAVIORS: {
  key: keyof CutBehavior;
  label: string;
  help: string;
}[] = [
  {
    key: "snapOnset",
    label: "Snap to click",
    help: "Moves the start of the clip onto the loudest transient inside your selection, so a loose drag still lands on the attack.",
  },
  {
    key: "trimTail",
    label: "Trim decay",
    help: "Ends the clip where the tail falls back into the room noise, cutting off any silence you dragged in by accident. Never extends past your selection.",
  },
  {
    key: "normalize",
    label: "Normalise",
    help: "Scales the clip so its loudest peak sits just under full scale, with a ceiling on how far a quiet recording can be pushed up.",
  },
  {
    key: "fade",
    label: "Fade edges",
    help: "Applies a very short fade in and out, which stops a hard cut from clicking on playback.",
  },
];

function CutBehaviorRow({
  behavior,
  onChange,
}: {
  behavior: CutBehavior;
  onChange: (key: keyof CutBehavior, value: boolean) => void;
}) {
  const isPreset = CUT_BEHAVIORS.every((item) => behavior[item.key] === ZCB_CUT_PRESET[item.key]);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-2">
      <span className="text-xs text-muted-foreground">On save</span>
      {CUT_BEHAVIORS.map((item) => {
        const id = `cut-behavior-${item.key}`;
        return (
          <div key={item.key} className="flex items-center gap-1.5">
            <Switch
              id={id}
              checked={behavior[item.key]}
              onCheckedChange={(value) => onChange(item.key, value)}
              aria-describedby={`${id}-help`}
            />
            <Label htmlFor={id} className="cursor-pointer text-xs">
              {item.label}
            </Label>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`What does ${item.label} do?`}
                  className="grid size-4 place-items-center rounded-full border border-border text-[9px] leading-none text-muted-foreground transition-colors hover:border-foreground hover:text-foreground focus-visible:ring-ring/40 focus-visible:ring-[3px] focus-visible:outline-none"
                >
                  ?
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-64 text-xs">
                {item.help}
              </TooltipContent>
            </Tooltip>
            <span id={`${id}-help`} className="sr-only">
              {item.help}
            </span>
          </div>
        );
      })}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={isPreset}
            onClick={() => CUT_BEHAVIORS.forEach((item) => onChange(item.key, ZCB_CUT_PRESET[item.key]))}
            className="ml-auto rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground hover:text-foreground focus-visible:ring-ring/40 focus-visible:ring-[3px] focus-visible:outline-none disabled:cursor-default disabled:opacity-60 disabled:hover:border-border disabled:hover:text-muted-foreground"
          >
            {isPreset ? "ZCB preset on" : "Apply ZCB preset"}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 text-xs">
          ZCB layers a click, a transient and a body on every press, and re-uses the tail as a
          resonance ring. Snapping to the attack, trimming the decay and normalising gives it the
          clean material it needs.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function EmptyState({ onRecord, total }: { onRecord: () => void; total: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="pointer-events-auto w-full max-w-md px-6 text-center">
        <h2 className="text-xl font-semibold tracking-tight">
          {total > 0 ? "Record another take" : "Record your first take"}
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground text-pretty">
          Put your microphone near whatever makes the sound, hit record, then click and tap
          normally. Every press and release is stamped onto the timeline.
        </p>
        <Button size="lg" onClick={onRecord} className="mt-6">
          Start recording
        </Button>
      </div>
    </div>
  );
}

function EmptyHint() {
  return (
    <p className="text-xs text-muted-foreground">
      Press R to record, then drag across the waveform to cut your first clip.
    </p>
  );
}
