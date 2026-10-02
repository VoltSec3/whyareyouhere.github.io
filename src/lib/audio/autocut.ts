import type { RecordedEvent } from "../events";
import { CATEGORY_MAP, type Category, type CategoryId } from "../types";

import {
  cutFromOnset,
  DEFAULT_CUT_OPTIONS,
  detectOnset,
  highPassSlice,
  medianMagnitude,
  RELEASE_SEARCH_AFTER,
  RELEASE_SEARCH_BEFORE,
  type Cut,
  type CutOptions,
  type OnsetHit,
} from "./process";

export type AutoCutOptions = {
  /** How far before an event the transient may have landed. */
  searchBefore: number;
  /** How far after an event the transient may have landed. */
  searchAfter: number;
  /**
   * Clicks quieter than this share of a typical click in the take are treated as
   * accidental taps rather than part of the performance.
   */
  relativeFloor: number;
  /** Absolute gate, so a silent take produces nothing at all. */
  minPeak: number;
  onProgress?: (done: number, total: number) => void;
};

export const DEFAULT_AUTOCUT_OPTIONS: AutoCutOptions = {
  searchBefore: 0.05,
  searchAfter: 0.25,
  relativeFloor: 0.06,
  minPeak: 0.0015,
};

/**
 * Silence reserved in front of every click, on top of its lead-in, so the
 * attack has somewhere to start instead of beginning on a cut.
 */
const ATTACK_GUARD = 0.0035;

/**
 * Minimum silence left between two adjacent clips. Without it a long click tail
 * runs straight into the next press and the release that follows gets buried.
 */
const MIN_ROOM = 0.004;

/**
 * The shortest clip worth keeping. A press whose own release lands within a few
 * milliseconds of it would otherwise be left with no room at all and be dropped
 * as too short to cut, losing the click as well as the lift.
 */
const MIN_CLIP_DURATION = 0.012;

/**
 * How long after the previous event's timestamp its own search may begin. Only
 * presses are bounded this way: a release is not measured against its
 * predecessor's timestamp but against the press attack actually located for it,
 * because a lift routinely lands within a few milliseconds of the press.
 */
const SEARCH_FLOOR = 0.025;

/**
 * How far past its press attack a release search may begin. Far enough to be
 * clear of the strike itself, close enough that a lift 15 ms after the press is
 * still inside the window.
 */
const PRESS_SETTLE = 0.005;

/**
 * The longest a release still counts as the button being lifted. A press may
 * legitimately ring for a couple of hundred milliseconds; a lift does not, and
 * left unbounded a release runs until the next event and carries the press's
 * body thump out with it.
 */
const RELEASE_MAX_DURATION = 0.06;

/**
 * How long after its press a release is still attributed to that press. Covers a
 * deliberate hold without pairing a lift with a press the user never let go of.
 */
const PAIR_WINDOW = 0.5;

/**
 * Which clip of a kind the accidental-tap floor is measured from.
 *
 * Measuring it against the loudest clip meant one hard click in the take decided
 * what counted as a tap for everything else. Ordinary deliberate clicking on the
 * same mouse sits around 25 dB below a hard slam, and the floor sat at 24 dB, so
 * a single deliberate hard click deleted the rest of the take and filed the two
 * survivors as micro - which is where "every click came out as a micro click"
 * came from. A high percentile ignores the outlier while still catching a real
 * tap, and with only a handful of clips it falls back to the loudest, which is
 * the right answer for a take that small.
 */
const TAP_FLOOR_PERCENTILE = 0.75;

/**
 * …and how far above the room the floor has to sit as well.
 *
 * Measuring the floor only against other clicks left it below the room tone
 * whenever the clicks were much louder than the noise, at which point every event
 * that landed in silence qualified as a clip of room tone. A clip has to stand
 * clear of the room to be a click at all, so the floor is the higher of the two.
 */
const TAP_FLOOR_OVER_ROOM = 3;

/** The value `fraction` of the way through a sorted copy of `values`, 0..1. */
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * Intensity bands as a share of the loudest click of the same kind. Roughly
 * -16 dB, -8 dB and -3 dB, which is about the spread between a fingertip on a
 * switch and a proper palm strike on the same mouse.
 */
const BANDS: { upTo: number; intensity: Category["intensity"] }[] = [
  { upTo: 0.16, intensity: "micro" },
  { upTo: 0.38, intensity: "soft" },
  { upTo: 0.72, intensity: "medium" },
  { upTo: Infinity, intensity: "hard" },
];

/**
 * How much of a click's transient counts as its loudness. Long enough to hold a
 * real click's body, short enough that a ringy tail cannot dominate.
 */
const TRANSIENT_WINDOW = 0.012;

/**
 * How much of the score comes from the peak rather than the body. A click is
 * impulsive, so the peak carries most of the perceived weight, but two clicks can
 * share a peak and differ entirely in size: a thin tick and a full thock. The
 * body term is what tells those two apart.
 */
const PEAK_WEIGHT = 0.65;

type Loudness = {
  peak: number;
  score: number;
};

/**
 * How a release is loud enough to be part of the performance. Measured in the
 * high-passed domain, because in the raw take a lift is quieter than the body
 * thump of the press it is still sitting inside, and measuring it there reported
 * the press - which is how every release in a take ended up filed as a hard
 * release regardless of how the button was actually used.
 */
type LoudnessDomain = "raw" | "click";

function measureLoudness(
  session: Float32Array,
  sessionRate: number,
  onsetSample: number,
  domain: LoudnessDomain,
): Loudness {
  const from = Math.max(0, Math.floor(onsetSample));
  const to = Math.min(session.length, from + Math.round(TRANSIENT_WINDOW * sessionRate));
  const window = domain === "click" ? highPassSlice(session, from, to) : session.subarray(from, to);
  let peak = 0;
  let sum = 0;
  const count = Math.max(1, window.length);
  for (let i = 0; i < window.length; i++) {
    const value = window[i]!;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / count);
  return { peak, score: PEAK_WEIGHT * peak + (1 - PEAK_WEIGHT) * rms };
}

export type AutoCutClip = {
  /** Where the event happened in the take. */
  eventTime: number;
  /** Where the click's attack was actually measured, in seconds. */
  onsetTime: number;
  kind: RecordedEvent["kind"];
  label: string;
  /**
   * Loudness against the loudest clip of the same kind, which is what the band
   * is read from when it is read at all. Peak and body are combined, so this is
   * not the clip's peak. A release that inherited its band from a press still
   * reports its own level here; see `intensitySource`.
   */
  relativeLoudness: number;
  intensity: Category["intensity"];
  /**
   * Whether the band came from this clip's own loudness, or from the press this
   * release came off.
   */
  intensitySource: "own" | "press";
  category: CategoryId;
  cut: Cut;
};

/** One event paired with the transient found for it. */
export type AnalysedEvent = {
  event: RecordedEvent;
  /** Index into the take's samples, or null when nothing transient was found. */
  onsetSample: number | null;
  onsetTime: number;
  hit: OnsetHit | null;
  /** Latest sample this event's clip may start at, so its lead-in stays intact. */
  startLatest: number;
  /** First sample the next event owns. */
  endLimit: number;
  /**
   * Index of the press this release came off, when there was one close enough to
   * be it. A lift is the end of a press, so this is what its intensity is read
   * from rather than from its own level.
   */
  pressPartner: number | null;
};

function categoryFor(intensity: Category["intensity"], kind: RecordedEvent["kind"]): CategoryId {
  const match = Object.values(CATEGORY_MAP).find(
    (category) => category.intensity === intensity && category.kind === kind,
  );
  if (!match) throw new Error(`no category for ${intensity} ${kind}`);
  return match.id;
}

const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Measures where every press and release in a take actually landed.
 *
 * Autocut runs this before it cuts anything, because the two events have to be
 * reasoned about together. A click's tail and the next click's lead-in compete
 * for the same milliseconds, and only a pass that knows both onsets can decide
 * where the split belongs.
 *
 * The search window of each event is bounded by its neighbours so a louder click
 * nearby cannot be mistaken for this one: the detector picks the strongest
 * transient inside the window, and a window that ran into the next event would
 * happily return it.
 */
export function analyseTake(
  samples: Float32Array,
  sampleRate: number,
  events: RecordedEvent[],
  options: Partial<AutoCutOptions> = {},
): AnalysedEvent[] {
  const settings = { ...DEFAULT_AUTOCUT_OPTIONS, ...options };
  const ordered = [...events].sort((a, b) => a.time - b.time);
  const leadInSamples = Math.round(DEFAULT_CUT_OPTIONS.leadIn * sampleRate);
  const guardSamples = Math.round(ATTACK_GUARD * sampleRate);

  // --- pass one: find the attack for every press ---
  const found: (OnsetHit | null)[] = [];
  const pressOnset = new Map<number, number>();
  for (const [index, event] of ordered.entries()) {
    if (event.kind !== "press") {
      found.push(null);
      continue;
    }
    const wantedStart = (event.time - settings.searchBefore) * sampleRate;
    const wantedEnd = (event.time + settings.searchAfter) * sampleRate;

    // Bound the window by its neighbours. Without the upper bound the detector
    // would be free to return the next click, which is louder more often than
    // not; without the lower bound it would return the previous one's tail.
    const next = ordered[index + 1];
    const prev = ordered[index - 1];
    const earliest = prev
      ? Math.max(wantedStart, (prev.time + SEARCH_FLOOR) * sampleRate)
      : wantedStart;
    const latest = next
      ? Math.min(wantedEnd, next.time * sampleRate - leadInSamples - guardSamples)
      : wantedEnd;

    // Two clicks closer together than the previous one's tail leave no quiet to
    // measure, which leaves no window: `earliest` is past `latest`. Searching it
    // anyway lands the boundary on that tail and drags the clip tens of
    // milliseconds past the click it belongs to, so this event is cut at its raw
    // timestamp instead. An unmeasured cut is inaudible next to a wrong one.
    if (latest <= earliest) {
      found.push(null);
      continue;
    }

    const from = Math.max(0, Math.floor(Math.min(earliest, samples.length)));
    const to = Math.min(samples.length, Math.ceil(Math.max(latest, from + 1)));
    const hit = detectOnset(samples, from, to, sampleRate);
    found.push(hit);
    if (hit) pressOnset.set(index, hit.sample);
  }

  // --- pass two: find each lift on the tail of the press it belongs to ---
  const pressPartner: (number | null)[] = ordered.map(() => null);
  for (const [index, event] of ordered.entries()) {
    if (event.kind !== "release") continue;

    const next = ordered[index + 1];
    const upperBound = next
      ? next.time * sampleRate - leadInSamples - guardSamples
      : (event.time + settings.searchAfter) * sampleRate;
    const latest = Math.min((event.time + RELEASE_SEARCH_AFTER) * sampleRate, upperBound);

    // The press this lift came off, if it is still close enough to be the one.
    let partner = -1;
    for (let back = index - 1; back >= 0; back--) {
      const candidate = ordered[back]!;
      if (candidate.kind !== "press") continue;
      if (candidate.source !== event.source || candidate.label !== event.label) break;
      if (event.time - candidate.time > PAIR_WINDOW) break;
      partner = back;
      break;
    }
    pressPartner[index] = partner >= 0 ? partner : null;

    const partnerOnset = pressOnset.get(partner);
    if (partnerOnset === undefined) {
      // Nothing to measure a decay against - the take started mid-hold, or the
      // pairing key changed. The lift is then an ordinary onset in near silence,
      // which the plain detector already handles.
      const from = Math.max(0, Math.floor((event.time - settings.searchBefore) * sampleRate));
      found[index] = detectOnset(samples, from, Math.ceil(latest), sampleRate);
      continue;
    }

    const from = Math.max(0, Math.floor(partnerOnset + PRESS_SETTLE * sampleRate));
    if (latest <= from) continue;

    // A lift is looked for in a window centred on its own timestamp, and the
    // press is only ever a floor on how early that window may start.
    //
    // This replaced a detector that hunted for "a rise out of the press's decay".
    // Against real switch recordings that detector never fired once: a decaying
    // tail is full of small rises, so it locked onto the first noise wiggle
    // hundreds of milliseconds before the lift, scored it at about 2x
    // prominence, and rejected its own result as noise. Every real release
    // therefore fell back to its raw timestamp, which is where the "no releases"
    // and "the release is just noise" reports came from.
    const liftFrom = Math.max(from, (event.time - RELEASE_SEARCH_BEFORE) * sampleRate);
    if (latest <= liftFrom) continue;
    found[index] = detectOnset(samples, Math.floor(liftFrom), Math.ceil(latest), sampleRate);
  }

  // --- pass three: hand out the boundaries ---
  const analysed: AnalysedEvent[] = ordered.map((event, index) => {
    const hit = found[index]!;
    // An event with no detectable transient still owns its raw timestamp, so it
    // gets a window of its own instead of borrowing a neighbour's audio.
    const onsetSample = hit
      ? hit.sample
      : Math.max(0, Math.min(samples.length - 1, Math.round(event.time * sampleRate)));
    return {
      event,
      onsetSample,
      onsetTime: onsetSample / sampleRate,
      hit,
      startLatest: Math.max(0, onsetSample - leadInSamples),
      endLimit: samples.length,
      pressPartner: pressPartner[index] ?? null,
    };
  });

  // Each clip stops where the next one needs to start. The guard and the room
  // are what stop a press from eating the release after it.
  const roomSamples = Math.round(MIN_ROOM * sampleRate);
  const minClipSamples = Math.round(MIN_CLIP_DURATION * sampleRate);
  const searchAfterSamples = Math.round(settings.searchAfter * sampleRate);
  for (const [index, entry] of analysed.entries()) {
    const next = analysed[index + 1];
    // The last click has no neighbour to stop it, so it is bounded by the search
    // window instead. Without this it runs to the end of the recording and
    // swallows any stray click recorded after the performance finished.
    const stop = next ? next.startLatest - guardSamples - roomSamples : entry.onsetSample! + searchAfterSamples;
    // The neighbour's boundary wins wherever it leaves a usable clip. It cannot
    // win everywhere: a press whose release lands almost on top of it is left
    // barely a millisecond, which is under the shortest clip a cut can produce,
    // so both halves of a fast click were being thrown away. The floor below
    // keeps a press worth saving even where that means running into the release's
    // lead-in, which is honest rather than convenient - the lift happens while
    // the press is still ringing, so the two do overlap in time.
    entry.endLimit = Math.max(
      entry.onsetSample! + minClipSamples,
      Math.min(entry.onsetSample! + searchAfterSamples, stop),
    );
  }

  return analysed;
}

export type OnsetSuggestion = {
  /** The event the suggestion belongs to. */
  event: RecordedEvent;
  /** Where the marker should sit, in seconds. */
  time: number;
  /** 0..1; the editor dims weak suggestions instead of hiding them. */
  confidence: number;
};

/**
 * Turns a take and its events into marker positions for the timeline, using the
 * same measurements autocut cuts with. Suggesting the raw event timestamp showed
 * a marker up to 50 ms away from the click it was meant to point at, which made
 * the suggestion look wrong even when the audio was right.
 */
export function suggestOnsets(
  samples: Float32Array,
  sampleRate: number,
  events: RecordedEvent[],
  options: Partial<AutoCutOptions> = {},
): OnsetSuggestion[] {
  return analyseTake(samples, sampleRate, events, options).map((entry) => ({
    event: entry.event,
    time: entry.onsetTime,
    // With no usable transient the marker sits on the event's own timestamp and is
    // drawn at the faintest weight instead of being hidden. A lift the detector
    // could not pull out of its press is still something the user can see, place
    // and save by hand, and hiding it left whole events with no marker at all.
    confidence: entry.hit ? entry.hit.confidence : 0,
  }));
}

function bandOf(relativeLoudness: number): Category["intensity"] {
  return BANDS.find((band) => relativeLoudness < band.upTo)?.intensity ?? "hard";
}

/** A lift is a tick. Left long it runs to the next event and takes the press's
 * body thump out with it, which is what made release clips a tenth of a second
 * long and louder than the click they were supposed to follow. */
const RELEASE_CUT_OPTIONS: CutOptions = {
  ...DEFAULT_CUT_OPTIONS,
  maxDuration: RELEASE_MAX_DURATION,
};

/**
 * Cuts a clip for every press and release in a take, then sorts them into
 * intensity bands.
 *
 * Boundaries come from the measured onsets rather than from each event's
 * timestamp in isolation, so a press cannot swallow the release that follows it:
 * the split lands in the quiet between the two, leaving the tail of the press
 * room to decay and the attack of the release room to arrive.
 *
 * Presses are banded on their own loudness - peak and body, off the raw take,
 * before normalisation and fades - against the loudest press of the take. A
 * lift cannot be banded that way. It is quiet by nature, and it is measured while
 * the press it belongs to is still ringing, so its own level says almost nothing
 * about how hard the button was used. Instead a release takes the band of the
 * press it came off: slam the mouse and both the click and the lift are hard.
 * A release with no press to inherit from - a take that started mid-hold - falls
 * back to being banded against the loudest release.
 */
export async function autocutTake(
  samples: Float32Array,
  sampleRate: number,
  events: RecordedEvent[],
  options: Partial<AutoCutOptions> = {},
): Promise<AutoCutClip[]> {
  const settings = { ...DEFAULT_AUTOCUT_OPTIONS, ...options };
  const analysed = analyseTake(samples, sampleRate, events, settings);
  if (analysed.length === 0) return [];

  const cuts: { index: number; entry: AnalysedEvent; cut: Cut }[] = [];
  for (const [index, entry] of analysed.entries()) {
    const cutOptions =
      entry.event.kind === "release" ? RELEASE_CUT_OPTIONS : DEFAULT_CUT_OPTIONS;
    const cut = cutFromOnset(samples, sampleRate, entry.onsetSample!, entry.endLimit, cutOptions);
    if (cut) cuts.push({ index, entry, cut });
    settings.onProgress?.(index + 1, analysed.length);
    if (index % 4 === 3) await yieldToUi();
  }

  // Loudness is measured once per clip, off the raw take, before normalisation
  // and fades, so the score reflects the performance rather than the processing.
  // A release is measured through the high-pass: in the raw take the press's
  // body thump it is sitting inside is the louder signal, and banding on that
  // files every release in a take as a hard release.
  const measured = cuts
    .filter((entry) => entry.cut.peakBefore >= settings.minPeak)
    .map((entry) => ({
      ...entry,
      ...measureLoudness(
        samples,
        sampleRate,
        entry.entry.onsetSample!,
        entry.entry.event.kind === "release" ? "click" : "raw",
      ),
    }));
  if (measured.length === 0) return [];

  // Each kind is judged against itself, so "standard lift" means the same thing as
  // "standard press" for this hand, on this mouse, at this microphone gain. A lift
  // is quieter than a press by nature, and one shared reference scaled to the
  // hardest press would push every ordinary release down a tier and leave the
  // release pools ZCB expects to be filled empty.
  //
  // The band reads off the loudest clip of the kind, which is what keeps the top
  // tier reachable. The tap floor deliberately does not; see TAP_FLOOR_PERCENTILE.
  const loudestScore = new Map<RecordedEvent["kind"], number>();
  const peaksByKind = new Map<RecordedEvent["kind"], number[]>();
  const roomFloor = medianMagnitude(samples);
  for (const { entry, peak, score } of measured) {
    const kind = entry.event.kind;
    loudestScore.set(kind, Math.max(loudestScore.get(kind) ?? 0, score));
    const list = peaksByKind.get(kind);
    if (list) list.push(peak);
    else peaksByKind.set(kind, [peak]);
  }

  const kept = measured.filter(({ entry, peak }) => {
    const ref = Math.max(
      percentile(peaksByKind.get(entry.event.kind) ?? [], TAP_FLOOR_PERCENTILE) * settings.relativeFloor,
      roomFloor * TAP_FLOOR_OVER_ROOM,
    );
    return ref > 0 && peak >= ref;
  });

  const byIndex = new Map(kept.map((entry) => [entry.index, entry]));
  const intensityOf = new Map<number, Category["intensity"]>();

  // Presses first: a release's band is read off one of them.
  for (const { index, score } of kept) {
    if (byIndex.get(index)!.entry.event.kind !== "press") continue;
    const ref = loudestScore.get("press") ?? 0;
    intensityOf.set(index, bandOf(ref > 0 ? score / ref : 0));
  }

  return kept.map(({ entry, cut, score }) => {
    const ref = loudestScore.get(entry.event.kind) ?? 0;
    // The loudest clip of a kind scores 1 by construction, so the top tier is
    // always reachable and never collapses into medium.
    const relativeLoudness = ref > 0 ? score / ref : 0;

    const partner = entry.pressPartner;
    const inherited = partner !== null ? intensityOf.get(partner) : undefined;
    const intensity = inherited ?? bandOf(relativeLoudness);

    return {
      eventTime: entry.event.time,
      onsetTime: entry.onsetTime,
      kind: entry.event.kind,
      label: entry.event.label,
      relativeLoudness,
      intensity,
      intensitySource: inherited !== undefined ? "press" : "own",
      category: categoryFor(intensity, entry.event.kind),
      cut,
    };
  });
}
