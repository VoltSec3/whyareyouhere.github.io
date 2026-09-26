export type EventKind = "press" | "release";
export type EventSource = "mouse" | "keyboard";

export type RecordedEvent = {
  id: string;
  kind: EventKind;
  source: EventSource;
  /** Seconds from the moment recording started. */
  time: number;
  label: string;
};

const MOUSE_LABELS: Record<number, string> = {
  0: "Left Mouse",
  1: "Middle Mouse",
  2: "Right Mouse",
  3: "Back Mouse",
  4: "Forward Mouse",
};

const KEY_ALIASES: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
};

function keyLabel(event: KeyboardEvent): string {
  if (event.key === "Space" || event.code === "Space") return "Space";
  const alias = KEY_ALIASES[event.key];
  if (alias) return alias;
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

let counter = 0;
const nextId = () => `evt_${Date.now().toString(36)}_${(counter++).toString(36)}`;

/**
 * Captures every mouse press/release and key press/release with a timestamp
 * relative to the start of the take, so each one can be located on the timeline.
 */
export class InputEventRecorder {
  private events: RecordedEvent[] = [];
  private startedAt = 0;
  private running = false;
  private readonly onEvent: (event: RecordedEvent) => void;

  constructor(onEvent: (event: RecordedEvent) => void = () => {}) {
    this.onEvent = onEvent;
  }

  private elapsed() {
    return (performance.now() - this.startedAt) / 1000;
  }

  private push(event: Omit<RecordedEvent, "id" | "time">) {
    if (!this.running) return;
    const record: RecordedEvent = { ...event, id: nextId(), time: this.elapsed() };
    this.events.push(record);
    this.onEvent(record);
  }

  private handleMouseDown = (event: MouseEvent) => {
    if (event.button > 4) return;
    this.push({
      kind: "press",
      source: "mouse",
      label: MOUSE_LABELS[event.button] ?? `Mouse ${event.button}`,
    });
  };

  private handleMouseUp = (event: MouseEvent) => {
    if (event.button > 4) return;
    this.push({
      kind: "release",
      source: "mouse",
      label: MOUSE_LABELS[event.button] ?? `Mouse ${event.button}`,
    });
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) return;
    if (isTypingTarget(event.target)) return;
    this.push({ kind: "press", source: "keyboard", label: keyLabel(event) });
  };

  private handleKeyUp = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) return;
    this.push({ kind: "release", source: "keyboard", label: keyLabel(event) });
  };

  private handleContextMenu = (event: MouseEvent) => {
    if (this.running) event.preventDefault();
  };

  start() {
    if (this.running) return;
    this.running = true;
    this.events = [];
    this.startedAt = performance.now();
    window.addEventListener("mousedown", this.handleMouseDown, true);
    window.addEventListener("mouseup", this.handleMouseUp, true);
    window.addEventListener("keydown", this.handleKeyDown, true);
    window.addEventListener("keyup", this.handleKeyUp, true);
    window.addEventListener("contextmenu", this.handleContextMenu, true);
  }

  stop(): RecordedEvent[] {
    if (!this.running) return this.events;
    this.running = false;
    window.removeEventListener("mousedown", this.handleMouseDown, true);
    window.removeEventListener("mouseup", this.handleMouseUp, true);
    window.removeEventListener("keydown", this.handleKeyDown, true);
    window.removeEventListener("keyup", this.handleKeyUp, true);
    window.removeEventListener("contextmenu", this.handleContextMenu, true);
    return this.events;
  }
}
