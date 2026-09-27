import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { PeakBucket } from "@/lib/audio/process";
import type { RecordedEvent } from "@/lib/events";

export type Selection = { start: number; end: number };
export type ViewWindow = { start: number; end: number };
export type Anchor = { x: number; y: number };

const MARKER_LANE = 30;
const RULER_HEIGHT = 22;
const HANDLE_WIDTH = 9;

export type TimelineProps = {
  peaks: PeakBucket[];
  duration: number;
  events: RecordedEvent[];
  selection: Selection | null;
  playhead: number;
  view: ViewWindow;
  live: boolean;
  snap: boolean;
  /** Purely visual: draws click/release markers without ever moving the cut. */
  suggest: boolean;
  savedMarkers: Selection[];
  className?: string;
  onViewChange: (view: ViewWindow) => void;
  onSeek: (time: number) => void;
  onSelect: (selection: Selection | null, anchor: Anchor | null) => void;
  onCommitSelect: (selection: Selection, anchor: Anchor) => void;
  onHoverTime?: (time: number | null) => void;
};

type DragMode = "new" | "resize-start" | "resize-end";

type DragState = {
  mode: DragMode | null;
  /** The edge that stays put while the other one is dragged. */
  anchor: number;
  /** Seconds between the pointer and the dragged edge when the drag began. */
  grabOffset: number;
  moved: boolean;
  latest: Selection | null;
};

const RULER_STEPS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

function resolveColor(value: string, fallback: string): string {
  if (!value) return fallback;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return fallback;
  ctx.fillStyle = value;
  return typeof ctx.fillStyle === "string" && ctx.fillStyle.length > 0 ? ctx.fillStyle : fallback;
}

/** Square-root response keeps quiet transients readable next to loud ones. */
function displayCurve(value: number): number {
  return (value < 0 ? -1 : 1) * Math.sqrt(Math.abs(value));
}

export function WaveformTimeline({
  peaks,
  duration,
  events,
  selection,
  playhead,
  view,
  live,
  snap,
  suggest,
  savedMarkers,
  className,
  onViewChange,
  onSeek,
  onSelect,
  onCommitSelect,
  onHoverTime,
}: TimelineProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [palette, setPalette] = useState<ReturnType<typeof readPalette> | null>(null);

  const dragRef = useRef<DragState>({
    mode: null,
    anchor: 0,
    grabOffset: 0,
    moved: false,
    latest: null,
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.max(0, entry.contentRect.width), height: Math.max(0, entry.contentRect.height) });
      setPalette(readPalette(host));
    });
    observer.observe(host);
    setSize({ width: host.clientWidth, height: host.clientHeight });
    setPalette(readPalette(host));
    return () => observer.disconnect();
  }, []);

  const span = Math.max(view.end - view.start, 0.0001);
  const waveTop = MARKER_LANE;
  const waveBottom = Math.max(waveTop + 24, size.height - RULER_HEIGHT);
  const waveHeight = waveBottom - waveTop;
  const mid = waveTop + waveHeight / 2;

  const timeToX = useCallback(
    (time: number) => ((time - view.start) / span) * size.width,
    [view.start, span, size.width],
  );

  const xToTime = useCallback(
    (x: number) => view.start + (x / Math.max(1, size.width)) * span,
    [view.start, span, size.width],
  );

  const snapTime = useCallback(
    (time: number) => {
      if (!snap) return time;
      const tolerance = span * 0.02;
      let best = time;
      let bestDistance = tolerance;
      for (const event of events) {
        const distance = Math.abs(event.time - time);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = event.time;
        }
      }
      return best;
    },
    [snap, events, span],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width || !size.height || !palette) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    ctx.fillStyle = palette.card;
    ctx.globalAlpha = 0.4;
    ctx.fillRect(0, waveTop, size.width, waveHeight);
    ctx.globalAlpha = 1;

    // grid + ruler
    const rawStep = (110 / size.width) * span;
    const step = RULER_STEPS.find((candidate) => candidate >= rawStep) ?? RULER_STEPS.at(-1)!;
    const minor = step / 5;

    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    const firstTick = Math.floor(view.start / minor) * minor;
    for (let t = firstTick; t <= view.end + minor; t += minor) {
      const x = Math.round(timeToX(t)) + 0.5;
      if (x < -2 || x > size.width + 2) continue;
      const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;

      ctx.strokeStyle = palette.border;
      ctx.globalAlpha = isMajor ? 0.8 : 0.32;
      ctx.beginPath();
      ctx.moveTo(x, waveTop);
      ctx.lineTo(x, waveBottom);
      ctx.stroke();

      if (isMajor) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = palette.muted;
        ctx.fillText(formatRuler(t, step), Math.max(3, x + 5), size.height - RULER_HEIGHT / 2);
      }
      ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = palette.border;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(size.width, Math.round(mid) + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // waveform
    const hasPeaks = peaks.length > 0 && duration > 0;
    if (hasPeaks) {
      let loudest = 0;
      for (const bucket of peaks) {
        loudest = Math.max(loudest, Math.abs(bucket.min), Math.abs(bucket.max));
      }
      const scale = loudest > 1e-6 ? 1 / loudest : 1;
      const half = waveHeight / 2 - 3;

      ctx.beginPath();
      for (let x = 0; x < size.width; x++) {
        const t0 = view.start + (x / size.width) * span;
        const t1 = view.start + ((x + 1) / size.width) * span;
        const i0 = Math.max(0, Math.floor((t0 / duration) * peaks.length));
        const i1 = Math.min(peaks.length, Math.max(i0 + 1, Math.ceil((t1 / duration) * peaks.length)));
        let min = 0;
        let max = 0;
        for (let i = i0; i < i1; i++) {
          const bucket = peaks[i];
          if (!bucket) continue;
          if (bucket.min < min) min = bucket.min;
          if (bucket.max > max) max = bucket.max;
        }
        const top = mid - displayCurve(max * scale) * half;
        const bottom = mid - displayCurve(min * scale) * half;
        ctx.rect(x, top, 1, Math.max(1, bottom - top));
      }
      ctx.fillStyle = palette.wave;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // dim outside the selection
    if (selection && selection.end > selection.start) {
      const x0 = timeToX(selection.start);
      const x1 = timeToX(selection.end);
      ctx.fillStyle = "rgba(0,0,0,0.42)";
      if (x0 > 0) ctx.fillRect(0, 0, Math.min(x0, size.width), size.height);
      if (x1 < size.width) ctx.fillRect(Math.max(0, x1), 0, size.width - Math.max(0, x1), size.height);

      ctx.strokeStyle = palette.primary;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(Math.round(x0) + 0.5, 0);
      ctx.lineTo(Math.round(x0) + 0.5, size.height);
      ctx.moveTo(Math.round(x1) + 0.5, 0);
      ctx.lineTo(Math.round(x1) + 0.5, size.height);
      ctx.stroke();

      ctx.fillStyle = palette.primary;
      for (const x of [x0, x1]) {
        const clamped = Math.max(0, Math.min(size.width - 6, x - 3));
        ctx.beginPath();
        ctx.roundRect(clamped, mid - 14, 6, 28, 3);
        ctx.fill();
      }
      ctx.lineWidth = 1;
    }

    // saved range ticks
    ctx.strokeStyle = palette.primary;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 3;
    for (const range of savedMarkers) {
      const x0 = timeToX(range.start);
      const x1 = timeToX(range.end);
      if (x1 < -4 || x0 > size.width + 4) continue;
      ctx.beginPath();
      ctx.moveTo(x0, waveBottom - 4);
      ctx.lineTo(Math.max(x1, x0 + 3), waveBottom - 4);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;

    // suggested click / release positions - advisory markers only
    if (suggest) {
      for (const event of events) {
        const x = Math.round(timeToX(event.time)) + 0.5;
        if (x < -8 || x > size.width + 8) continue;
        const isPress = event.kind === "press";
        const color = isPress ? palette.press : palette.release;

        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        ctx.moveTo(x, MARKER_LANE - 7);
        ctx.lineTo(x, waveBottom);
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.fillStyle = color;
        ctx.beginPath();
        if (isPress) {
          ctx.moveTo(x - 4.5, 1);
          ctx.lineTo(x + 4.5, 1);
          ctx.lineTo(x, 9);
        } else {
          ctx.moveTo(x - 4.5, 9);
          ctx.lineTo(x + 4.5, 9);
          ctx.lineTo(x, 1);
        }
        ctx.closePath();
        ctx.fill();

        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.arc(x, MARKER_LANE, isPress ? 2.8 : 2.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // playhead
    if (playhead >= view.start && playhead <= view.end) {
      const x = Math.round(timeToX(playhead)) + 0.5;
      ctx.strokeStyle = palette.foreground;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.height);
      ctx.stroke();

      ctx.fillStyle = palette.foreground;
      ctx.beginPath();
      ctx.roundRect(x - 4.5, size.height - RULER_HEIGHT, 9, RULER_HEIGHT, 2);
      ctx.fill();
    }
  }, [
    size,
    palette,
    peaks,
    duration,
    events,
    suggest,
    selection,
    playhead,
    view,
    span,
    waveTop,
    waveBottom,
    waveHeight,
    mid,
    timeToX,
    live,
    savedMarkers,
  ]);

  const pointToTime = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    return Math.max(0, Math.min(duration, snapTime(xToTime(x))));
  };

  /** Viewport point the popup menu should point at for a given selection. */
  const anchorFor = (value: Selection): Anchor => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const x0 = timeToX(value.start);
    const x1 = timeToX(value.end);
    return {
      x: rect.left + (x0 + x1) / 2,
      y: rect.top + MARKER_LANE + 10,
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (live || !duration) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const time = pointToTime(event);
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;

    // Dragging inside the existing selection starts a fresh one; only the two
    // edge grips resize. That keeps "drag -> menu -> save" working every time.
    //
    // The grip has a hit tolerance and the grab point is snapped, so `time` can
    // land a little away from the real edge. Resizing therefore anchors to the
    // selection's own edge and keeps the distance between the pointer and the
    // grabbed edge, instead of letting the opposite edge snap to the pointer.
    let mode: DragMode = "new";
    let anchor = time;
    let grabOffset = 0;
    if (selection && selection.end > selection.start) {
      const x0 = timeToX(selection.start);
      const x1 = timeToX(selection.end);
      if (Math.abs(x - x0) <= HANDLE_WIDTH) {
        mode = "resize-start";
        anchor = selection.end;
        grabOffset = time - selection.start;
      } else if (Math.abs(x - x1) <= HANDLE_WIDTH) {
        mode = "resize-end";
        anchor = selection.start;
        grabOffset = time - selection.end;
      }
    }

    dragRef.current = { mode, anchor, grabOffset, moved: false, latest: null };

    if (mode === "new") {
      const zero = { start: time, end: time };
      onSelect(zero, anchorFor(zero));
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag.mode) {
      const rect = event.currentTarget.getBoundingClientRect();
      onHoverTime?.(xToTime(event.clientX - rect.left));
      return;
    }

    const time = pointToTime(event);
    // Measure the gesture in raw pixels: `time` is clamped to the take, so a
    // drag that runs off the end would otherwise look like a plain click.
    const rect = event.currentTarget.getBoundingClientRect();
    if (Math.abs(event.clientX - rect.left - timeToX(drag.anchor)) > 3) drag.moved = true;

    const next: Selection =
      drag.mode === "resize-start"
        ? { start: Math.max(0, Math.min(time - drag.grabOffset, drag.anchor)), end: drag.anchor }
        : drag.mode === "resize-end"
          ? {
              start: drag.anchor,
              end: Math.min(duration, Math.max(time - drag.grabOffset, drag.anchor)),
            }
          : { start: Math.min(drag.anchor, time), end: Math.max(drag.anchor, time) };

    drag.latest = next;
    onSelect(next, anchorFor(next));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = { mode: null, anchor: 0, grabOffset: 0, moved: false, latest: null };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.mode) return;

    if (!drag.moved) {
      if (drag.mode === "new") {
        onSelect(null, null);
        onSeek(drag.anchor);
      }
      return;
    }

    if (drag.latest && drag.latest.end - drag.latest.start > 0.005) {
      onCommitSelect(drag.latest, anchorFor(drag.latest));
    } else {
      onSelect(null, null);
    }
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (live || !duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const focus = xToTime(event.clientX - rect.left);

    if (event.ctrlKey || event.metaKey) {
      const nextSpan = Math.max(0.04, Math.min(duration, span * Math.exp(event.deltaY * 0.0022)));
      const ratio = (focus - view.start) / span;
      const start = Math.max(0, Math.min(duration - nextSpan, focus - ratio * nextSpan));
      onViewChange({ start, end: start + nextSpan });
      return;
    }

    const source = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const reference = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? rect.width : rect.height;
    const delta = (source / Math.max(1, reference)) * span * 0.9;
    const start = Math.max(0, Math.min(duration - span, view.start + delta));
    onViewChange({ start, end: start + span });
  };

  const hasSelection = !!selection && selection.end - selection.start > 0.005;
  const cursor = live ? "default" : hasSelection ? "ew-resize" : "crosshair";

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ cursor }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={() => onHoverTime?.(null)}
      onWheel={handleWheel}
    >
      <canvas ref={canvasRef} className="block size-full touch-none select-none" />
    </div>
  );
}

function readPalette(host: HTMLElement) {
  const styles = getComputedStyle(host);
  const read = (name: string, fallback: string) =>
    resolveColor(styles.getPropertyValue(name).trim(), fallback);
  return {
    press: read("--click", "#f97316"),
    release: read("--release", "#38bdf8"),
    wave: read("--wave", "#94a3b8"),
    primary: read("--brand", "#f97316"),
    muted: read("--muted-foreground", "#94a3b8"),
    border: read("--border", "#1e293b"),
    foreground: read("--foreground", "#f8fafc"),
    card: read("--card", "#0f172a"),
  };
}

function formatRuler(time: number, step: number): string {
  if (step < 1) return `${time.toFixed(2)}s`;
  if (time < 60) return `${Math.round(time)}s`;
  return `${Math.floor(time / 60)}:${String(Math.round(time % 60)).padStart(2, "0")}`;
}
