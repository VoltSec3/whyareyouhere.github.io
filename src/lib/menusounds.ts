import { analyseTake } from "./audio/autocut";
import { cutFromOnset, DEFAULT_CUT_OPTIONS, type Cut } from "./audio/process";
import { encodeWav, TARGET_SAMPLE_RATE } from "./audio/wav";
import type { RecordedEvent } from "./events";

/**
 * Menu sounds are a different thing from the intensity tiers a clickpack is built
 * out of, and they are kept in their own store for that reason:
 *
 * - A tier answers "how hard", so it is sorted by loudness and ZCB re-scales it.
 *   A menu sound answers "what did the player just do", so a menu click and an
 *   Escape press are not variations of each other and must not share a folder.
 * - ZCB plays them in completely different places. A gameplay press can only be
 *   replaced by another gameplay press, while Escape plays anywhere and typing
 *   plays only while the player is actually typing. So a failure to load one of
 *   them cannot be papered over by falling back to the other.
 * - The exported folders live outside the slot tree, because they are not per
 *   player. Two players sharing one keyboard share one Escape sound.
 * - Press and release are separate pools, not one pool with a flag. A switch
 *   letting go is a different noise from a switch being hit, and ZCB plays them at
 *   different moments, so they are cut, levelled, stored and exported apart.
 */
export type MenuSoundId = "escape" | "menuclicks" | "typing";

/**
 * Which half of a gesture a clip is the sound of.
 *
 * A release is a genuinely different noise from the press that came before it -
 * a switch letting go rather than a switch being hit - so it is a separate pool
 * and a separate folder rather than a flag on the same pool. ZCB plays the two at
 * different moments: the press on mouse-down, the release on mouse-up.
 */
export type MenuSoundPhase = "press" | "release";

export const MENU_PHASES: readonly MenuSoundPhase[] = ["press", "release"] as const;

/** Clips held per pool, which is what every counter in the UI is asking about. */
export type MenuSoundCounts = Record<MenuSoundId, Record<MenuSoundPhase, number>>;

/** An empty count map, so a caller never has to build the nested shape by hand. */
export function emptyMenuSoundCounts(): MenuSoundCounts {
  return Object.fromEntries(
    MENU_CATEGORIES.map((category) => [category.id, { press: 0, release: 0 }]),
  ) as MenuSoundCounts;
}

/** How a phase is named in the library and the export summary. */
export function menuPhaseLabel(phase: MenuSoundPhase): string {
  return phase === "release" ? "release" : "press";
}

/** The release pool for a kind, for the kinds where letting go is its own sound. */
export type MenuSoundRelease = {
  /** The folder ZCB reads this kind's releases from. */
  folder: string;
  /**
   * How many release clips to aim for. The same number as the press target on
   * purpose: one take captures a press and its release together, so a person who
   * has filled the press pool has already filled this one.
   */
  target: number;
  /** One line on why the release is worth recording. */
  hint: string;
  /** Ceiling on a single release clip, in seconds. */
  maxDuration: number;
};

export type MenuSoundCategory = {
  id: MenuSoundId;
  label: string;
  /** The folder ZCB reads this kind's presses from. */
  folder: string;
  /**
   * How many clips to aim for. This is a target and not a minimum: stopping later
   * simply banks more samples, and stopping early is allowed with whatever was
   * captured.
   */
  target: number;
  /** What the person is being asked to do. */
  prompt: string;
  /** One line on why this many. */
  hint: string;
  /** Ceiling on a single clip, in seconds. */
  maxDuration: number;
  /**
   * The release pool, present only for the kinds that have one.
   *
   * Only menu clicks do. Escape is a single deliberate press on a keyboard switch
   * that the player barely holds, so its release is barely a sound and banking one
   * would mostly add room noise. Typing is the opposite case: a key is held for
   * as long as it takes to type, so a release would land at an arbitrary point in a
   * sentence and be played after a character the player never finished.
   */
  release?: MenuSoundRelease;
};

export const MENU_CATEGORIES: readonly MenuSoundCategory[] = [
  {
    id: "escape",
    label: "Escape",
    folder: "escape",
    target: 10,
    prompt: "Press Escape, one at a time.",
    hint: "ZCB plays this on Escape from anywhere, including in a level, so a single clean sample is often enough.",
    maxDuration: 0.3,
  },
  {
    id: "menuclicks",
    label: "Menu clicks",
    folder: "menuclicks",
    target: 25,
    // Press *and* release, because a take banks both halves of the gesture.
    prompt: "Click and let go anywhere outside this window.",
    hint: "Only heard outside gameplay. 25 gives enough variety that a menu does not start sounding like one sample on loop.",
    maxDuration: 0.3,
    release: {
      folder: "menuclicksreleases",
      target: 25,
      hint: "The sound of letting go. ZCB plays it on mouse-up, so it is what stops a click from sounding like it was cut off mid-press.",
      maxDuration: 0.3,
    },
  },
  {
    id: "typing",
    label: "Typing",
    folder: "typing",
    target: 50,
    prompt: "Type into the box below, one key at a time.",
    hint: "The most asked for, because it is heard on every character. ZCB overlaps these, so several can ring at once.",
    maxDuration: 0.4,
  },
] as const;

export const MENU_CATEGORY_MAP = Object.fromEntries(
  MENU_CATEGORIES.map((category) => [category.id, category]),
) as Record<MenuSoundId, MenuSoundCategory>;

export type StoredMenuSound = {
  id: string;
  category: MenuSoundId;
  /** Whether this is the press or the release of the gesture. */
  phase: MenuSoundPhase;
  name: string;
  /** Seconds into the step's recording the clip was taken from. */
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  peak: number;
  gain: number;
  createdAt: number;
  /** 16-bit PCM WAV payload. */
  wav: ArrayBuffer;
};

/** Level below which a captured event is treated as a stray tap, not a sample. */
const MIN_SAMPLE_PEAK = 0.002;

/** Share of a category's loudest clip the whole category is normalised to. */
const CATEGORY_PEAK = 0.92;

/** A keystroke that changes state rather than typing a character. */
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "ContextMenu",
]);

/**
 * Whether a keydown is one ZCB will play a typing sound for.
 *
 * ZCB decides this from `WM_CHAR` rather than from the key, because a held key
 * autorepeats key *downs* and would otherwise play a click per repeat. That means
 * ZCB only hears keys that produce a character, so the recorder has to bank on
 * exactly the same rule. The two drifting apart is not a cosmetic difference: the
 * pool is picked at random, so a clip of Enter banked here would be played for a
 * letter, which is worse than not having recorded it.
 *
 * That does give up the edit keys - Enter, Backspace, Tab and so on are not
 * pooled. On the runtime side they cannot be told apart from the same keys during
 * gameplay, where the arrow keys are player controls, and Escape has a pool of its
 * own.
 */
export function isTypingKey(key: string): boolean {
  if (MODIFIER_KEYS.has(key)) return false;
  if (key === "Escape") return false;
  // A single code unit is a character: letters, digits, punctuation and space.
  // Longer keys are named controls ("Enter", "ArrowLeft"), and anything past the
  // basic plane arrives as a surrogate pair, which ZCB sees as two WM_CHARs and
  // would play twice for one recorded clip.
  return key.length === 1;
}

export type MenuCaptureEvent = {
  /** Seconds from the start of the step's recording. */
  time: number;
  label: string;
  /** Which half of the gesture this event is. */
  phase: MenuSoundPhase;
};

/**
 * Cut options for one menu category and phase.
 *
 * `normalize` is off on purpose. The shared extractor normalises each clip on its
 * own, which is right for the click library - every tier is meant to sound full -
 * but it destroys the one thing a menu pool exists for, which is the difference
 * between a soft keystroke and a hard one. Turning it off leaves every clip at its
 * recorded level so the pool can be levelled in one pass below.
 */
function cutOptionsFor(category: MenuSoundCategory, phase: MenuSoundPhase) {
  const release = phase === "release" ? category.release : undefined;
  return {
    ...DEFAULT_CUT_OPTIONS,
    maxDuration: release ? release.maxDuration : category.maxDuration,
    normalize: false,
  };
}

/**
 * Cuts one clip per captured event out of a step's recording.
 *
 * The same measured onsets and the same gap-aware boundaries autocut uses, so a
 * step recorded at full speed lands the split in the quiet between two events
 * instead of letting the first clip swallow the second. The boundary logic also
 * leaves a lead-in in front of every attack, which matters more here than for
 * gameplay: a menu sound is usually short, and starting it on the attack with
 * nothing in front is what makes it click cleanly rather than thump.
 *
 * A take that contains both presses and releases is split between them on exactly
 * the same terms, so a press ends where its own release begins. That is the whole
 * point of recording the release: it is the sound of the boundary, and a press cut
 * to run past its own release would play the release twice.
 *
 * Clips are normalised per pool rather than individually. Individually would
 * flatten a hard Escape press and a soft one to the same level, and the point of
 * having recorded ten of them is the variation between them. Presses and releases
 * are levelled separately from each other for the same reason: they are never
 * played against one another, so a release pool measured against a hard press would
 * come out as a whisper.
 */
export function cutMenuStep(
  samples: Float32Array,
  sampleRate: number,
  events: MenuCaptureEvent[],
  category: MenuSoundCategory,
): { cut: Cut; event: MenuCaptureEvent }[] {
  if (samples.length === 0 || events.length === 0) return [];

  // A menu click is a mouse, everything else is a key. Which half of the gesture
  // an event is comes from the event itself, not from the category: one take
  // carries both.
  const source: RecordedEvent["source"] = category.id === "menuclicks" ? "mouse" : "keyboard";
  const byId = new Map<string, MenuCaptureEvent>();
  const options: Partial<Record<MenuSoundPhase, ReturnType<typeof cutOptionsFor>>> = {};
  for (const phase of MENU_PHASES) options[phase] = cutOptionsFor(category, phase);
  const recorded: RecordedEvent[] = events.map((event, index) => {
    const id = `menu_${index}`;
    byId.set(id, event);
    return { id, time: event.time, kind: event.phase, source, label: event.label };
  });

  const analysed = analyseTake(samples, sampleRate, recorded);
  const results: { cut: Cut; event: MenuCaptureEvent }[] = [];
  for (const entry of analysed) {
    if (entry.hit === null) continue;
    const event = byId.get(entry.event.id);
    if (!event) continue;
    const cut = cutFromOnset(
      samples,
      sampleRate,
      entry.onsetSample!,
      entry.endLimit,
      options[event.phase]!,
    );
    if (!cut || cut.peakBefore < MIN_SAMPLE_PEAK) continue;
    results.push({ cut, event });
  }

  // One level per pool, so the spread between samples survives. Clips come out of
  // `extract` unnormalised, so this is the only gain applied and the loudest clip
  // in each pool lands on CATEGORY_PEAK exactly.
  for (const phase of MENU_PHASES) {
    const pool = results.filter((entry) => entry.event.phase === phase);
    const loudest = pool.reduce((max, entry) => Math.max(max, entry.cut.peakBefore), 0);
    if (loudest <= 0) continue;
    const shared = CATEGORY_PEAK / loudest;
    for (const entry of pool) {
      const out = entry.cut.samples;
      for (let i = 0; i < out.length; i++) out[i] = out[i]! * shared;
      entry.cut.gain = shared;
    }
  }
  return results;
}

let counter = 0;

/**
 * Peak of the samples as they will actually be exported.
 *
 * `cut.peakBefore` is the level coming out of the recording, and it is *not*
 * what gets written: `cutMenuStep` then applies one shared gain across the
 * category, so the stored value has to be measured after that or the library
 * shows a level the file does not have. Measured rather than computed from
 * `peakBefore * gain` so it stays correct if the gain chain ever gains a stage.
 */
function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
  return peak;
}

/** Wraps a cut clip in the shape the menu store keeps. */
export function toStoredMenuSound(
  cut: Cut,
  category: MenuSoundId,
  phase: MenuSoundPhase,
  index: number,
): StoredMenuSound {
  const wav = encodeWav(cut.samples, TARGET_SAMPLE_RATE).buffer as ArrayBuffer;
  const label = MENU_CATEGORY_MAP[category].label;
  return {
    id: `menu_${category}_${phase}_${Date.now().toString(36)}_${(counter++).toString(36)}_${index}`,
    category,
    phase,
    // Numbered per pool, so "Menu clicks release 3" is the third release rather
    // than the third thing recorded on the step.
    name:
      phase === "release" ? `${label} release ${index + 1}` : `${label} ${index + 1}`,
    sourceStart: cut.start,
    sourceEnd: cut.end,
    duration: cut.samples.length / TARGET_SAMPLE_RATE,
    peak: peakOf(cut.samples),
    gain: cut.gain,
    createdAt: Date.now() + counter,
    wav,
  };
}

/** The kinds a pack has at least one press clip of, in category order. */
export function presentMenuKinds(sounds: readonly StoredMenuSound[]): MenuSoundId[] {
  const counts = new Map<MenuSoundId, number>();
  for (const sound of sounds) {
    if (sound.phase !== "press") continue;
    counts.set(sound.category, (counts.get(sound.category) ?? 0) + 1);
  }
  return MENU_CATEGORIES.filter((category) => (counts.get(category.id) ?? 0) > 0).map(
    (category) => category.id,
  );
}
