import type { RecordedEvent } from "../events";
import { CATEGORY_MAP, type Category, type CategoryId } from "../types";

import { cutSegment, DEFAULT_CUT_OPTIONS, type Cut } from "./process";

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
 * Intensity bands as a share of the loudest click in the take. Roughly -24 dB,
 * -12 dB and -5 dB, which is about the spread between a fingertip on a switch
 * and a proper palm strike on the same mouse.
 */
const BANDS: { upTo: number; intensity: Category["intensity"] }[] = [
  { upTo: 0.16, intensity: "micro" },
  { upTo: 0.38, intensity: "soft" },
  { upTo: 0.72, intensity: "medium" },
  { upTo: Infinity, intensity: "hard" },
];

export type AutoCutClip = {
  /** Where the event happened in the take. */
  eventTime: number;
  kind: RecordedEvent["kind"];
  label: string;
  /** Peak of the clip before it was normalised, used for the band. */
  relativePeak: number;
  intensity: Category["intensity"];
  category: CategoryId;
  cut: Cut;
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
 * Cuts a clip for every press and release in a take, then sorts them into
 * intensity bands by how loud each one was before normalisation.
 *
 * The transient is located with the same onset and tail search the editor uses
 * for a hand-drawn selection, so an automatically cut clip is cut the same way a
 * careful one would be. Loudness is judged against the loudest click in the take
 * rather than an absolute dBFS figure, so it works at any microphone gain.
 */
export async function autocutTake(
  samples: Float32Array,
  sampleRate: number,
  events: RecordedEvent[],
  options: Partial<AutoCutOptions> = {},
): Promise<AutoCutClip[]> {
  const settings = { ...DEFAULT_AUTOCUT_OPTIONS, ...options };
  const ordered = [...events].sort((a, b) => a.time - b.time);

  const cuts: { event: RecordedEvent; cut: Cut }[] = [];
  for (const [index, event] of ordered.entries()) {
    const cut = cutSegment(
      samples,
      sampleRate,
      event.time - settings.searchBefore,
      event.time + settings.searchAfter,
      DEFAULT_CUT_OPTIONS,
    );
    if (cut) cuts.push({ event, cut });
    settings.onProgress?.(index + 1, ordered.length);
    if (index % 4 === 3) await yieldToUi();
  }

  const loudest = cuts.reduce((max, entry) => Math.max(max, entry.cut.peakBefore), 0);
  if (loudest <= 0) return [];

  const floor = Math.max(settings.minPeak, loudest * settings.relativeFloor);

  return cuts
    .filter((entry) => entry.cut.peakBefore >= floor)
    .map(({ event, cut }) => {
      const relativePeak = cut.peakBefore / loudest;
      const intensity = BANDS.find((band) => relativePeak < band.upTo)?.intensity ?? "hard";
      return {
        eventTime: event.time,
        kind: event.kind,
        label: event.label,
        relativePeak,
        intensity,
        category: categoryFor(intensity, event.kind),
        cut,
      };
    });
}
