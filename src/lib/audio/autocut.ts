import type { RecordedEvent } from "../events";
import { CATEGORY_MAP, type Category, type CategoryId } from "../types";

import { cutFromOnset, DEFAULT_CUT_OPTIONS, detectOnset, type Cut, type OnsetHit } from "./process";

export type AutoCutOptions = {
  /** How far before an event the transient may have landed. */
  searchBefore: number;
  /** How far after an event the transient may have landed. */
  searchAfter: number;
  /**
   * Clicks quieter than this share of the loudest click in the take are treated
   * as accidental taps rather than part of the performance.
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
 * How long after the previous event's timestamp its own search may begin. Long
 * enough to skip the previous click's tail, short enough that a release measured
 * shortly after its press can still find its own attack.
 */
const SEARCH_FLOOR = 0.025;

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
 * Measures one click off the raw take, before normalisation and fades, so the
 * score reflects the performance rather than the processing.
 */
function measureLoudness(
  session: Float32Array,
  sessionRate: number,
  onsetSample: number,
): Loudness {
  const from = Math.max(0, Math.floor(onsetSample));
  const to = Math.min(session.length, from + Math.round(TRANSIENT_WINDOW * sessionRate));
  let peak = 0;
  let sum = 0;
  const count = Math.max(1, to - from);
  for (let i = from; i < to; i++) {
    const value = session[i]!;
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
   * Loudness against the loudest click of the same kind, which is what the band
   * is read from. Peak and body are combined, so this is not the clip's peak.
   */
  relativeLoudness: number;
  intensity: Category["intensity"];
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

  // --- pass one: find the attack for every event ---
  const found: (OnsetHit | null)[] = [];
  for (const [index, event] of ordered.entries()) {
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
    found.push(detectOnset(samples, from, to, sampleRate));
  }

  // --- pass two: hand out the boundaries ---
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
    };
  });

  // Each clip stops where the next one needs to start. The guard and the room
  // are what stop a press from eating the release after it.
  const roomSamples = Math.round(MIN_ROOM * sampleRate);
  for (const [index, entry] of analysed.entries()) {
    const next = analysed[index + 1];
    // The last click has no neighbour to stop it, so it is bounded by the search
    // window instead. Without this it runs to the end of the recording and
    // swallows any stray click recorded after the performance finished.
    const stop = next
      ? next.startLatest - guardSamples - roomSamples
      : entry.onsetSample! + Math.round(settings.searchAfter * sampleRate);
    // The neighbour's boundary always wins. Treating MIN_CLIP as a floor here
    // could push a clip past its own boundary and into the next attack, which
    // reads as one click bleeding into the next; truncating instead is the
    // lesser fault. The outer floor guarantees a clip is never shorter than the
    // transient it was cut for.
    entry.endLimit = Math.max(
      entry.onsetSample!,
      Math.min(entry.onsetSample! + Math.round(settings.searchAfter * sampleRate), stop),
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
  return analyseTake(samples, sampleRate, events, options)
    .filter((entry) => entry.hit !== null && entry.hit.confidence > 0)
    .map((entry) => ({
      event: entry.event,
      time: entry.onsetTime,
      confidence: entry.hit!.confidence,
    }));
}

/**
 * Cuts a clip for every press and release in a take, then sorts them into
 * intensity bands by how loud each one was before normalisation.
 *
 * Boundaries come from the measured onsets rather than from each event's
 * timestamp in isolation, so a press cannot swallow the release that follows it:
 * the split lands in the quiet between the two, leaving the tail of the press
 * room to decay and the attack of the release room to arrive.
 *
 * Loudness is measured off the raw take as a blend of peak and body, and judged
 * against the loudest click of the same kind rather than an absolute dBFS
 * figure, so it works at any microphone gain and a lift is not mistaken for a
 * faint press just because lifts are quieter than presses.
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

  const cuts: { entry: AnalysedEvent; cut: Cut }[] = [];
  for (const [index, entry] of analysed.entries()) {
    const cut = cutFromOnset(samples, sampleRate, entry.onsetSample!, entry.endLimit, DEFAULT_CUT_OPTIONS);
    if (cut) cuts.push({ entry, cut });
    settings.onProgress?.(index + 1, analysed.length);
    if (index % 4 === 3) await yieldToUi();
  }

  // Loudness is measured once per clip, off the raw take, before normalisation
  // and fades, so the score reflects the performance rather than the processing.
  const measured = cuts
    .filter((entry) => entry.cut.peakBefore >= settings.minPeak)
    .map((entry) => ({ ...entry, ...measureLoudness(samples, sampleRate, entry.entry.onsetSample!) }));
  if (measured.length === 0) return [];

  // Each kind is judged against the loudest click of its own kind, for both the
  // tap floor and the band. A lift is quieter than a press by nature, so one
  // shared reference scaled to the hardest press pushes every ordinary release
  // down a tier and leaves the release pools ZCB expects to be filled empty.
  // Scoring within the kind instead makes "standard lift" mean the same thing as
  // "standard press" for this hand, on this mouse, at this microphone gain.
  const loudestPeak = new Map<RecordedEvent["kind"], number>();
  const loudestScore = new Map<RecordedEvent["kind"], number>();
  for (const { entry, peak, score } of measured) {
    const kind = entry.event.kind;
    loudestPeak.set(kind, Math.max(loudestPeak.get(kind) ?? 0, peak));
    loudestScore.set(kind, Math.max(loudestScore.get(kind) ?? 0, score));
  }

  return measured
    .filter(({ entry, peak }) => {
      const ref = loudestPeak.get(entry.event.kind) ?? 0;
      return ref > 0 && peak >= ref * settings.relativeFloor;
    })
    .map(({ entry, cut, score }) => {
      // The loudest click of a kind scores 1 by construction, so the top tier is
      // always reachable and never collapses into medium.
      const ref = loudestScore.get(entry.event.kind) ?? 0;
      const relativeLoudness = ref > 0 ? score / ref : 0;
      const intensity = BANDS.find((band) => relativeLoudness < band.upTo)?.intensity ?? "hard";
      return {
        eventTime: entry.event.time,
        onsetTime: entry.onsetTime,
        kind: entry.event.kind,
        label: entry.event.label,
        relativeLoudness,
        intensity,
        category: categoryFor(intensity, entry.event.kind),
        cut,
      };
    });
}
