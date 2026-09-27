/** Min/max peak pairs used to draw a waveform without touching the full buffer. */
export type PeakBucket = { min: number; max: number };

export function computePeaks(samples: Float32Array, bucketCount: number): PeakBucket[] {
  const peaks: PeakBucket[] = [];
  const count = Math.max(1, Math.floor(bucketCount));
  const per = samples.length / count;

  for (let b = 0; b < count; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(samples.length, Math.floor((b + 1) * per));
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks.push({ min, max });
  }

  return peaks;
}

/** Root-mean-square energy envelope, one value per `windowSize` samples. */
export function computeEnvelope(samples: Float32Array, windowSize: number): Float32Array {
  const size = Math.max(1, Math.floor(windowSize));
  const count = Math.max(1, Math.floor(samples.length / size));
  const out = new Float32Array(count);

  for (let w = 0; w < count; w++) {
    const start = w * size;
    const end = Math.min(samples.length, start + size);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    out[w] = Math.sqrt(sum / Math.max(1, end - start));
  }

  return out;
}

/**
 * Locates the strongest transient inside a window. Uses short-term energy rise
 * so a click is preferred over the louder low-frequency rumble around it.
 */
export function findOnset(
  samples: Float32Array,
  startSample: number,
  endSample: number,
  sampleRate: number,
): number {
  const from = Math.max(0, Math.floor(startSample));
  const to = Math.min(samples.length, Math.floor(endSample));
  if (to - from < 2) return from;

  const window = Math.max(8, Math.round(sampleRate * 0.002));
  const envelope = computeEnvelope(samples.subarray(from, to), window);
  if (envelope.length === 0) return from;

  let bestIndex = 0;
  let bestScore = -Infinity;
  const lookahead = 3;
  for (let i = 0; i < envelope.length; i++) {
    let future = 0;
    for (let k = 0; k <= lookahead && i + k < envelope.length; k++) future += envelope[i + k];
    const score = envelope[i] * 0.5 + (future / (lookahead + 1)) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return from + bestIndex * window;
}

export type TailOptions = {
  /** Energy the tail must fall below, relative to the transient. */
  floorRatio: number;
  /** …but never below this multiple of the estimated noise floor. */
  noiseMultiplier: number;
  /** How long the tail must stay quiet before it counts as the end. */
  holdDuration: number;
  maxDuration: number;
  minDuration: number;
  /**
   * Hard ceiling in samples. A cut may never run past the region the user
   * selected, however long the tail rings.
   */
  endLimit?: number;
};

/**
 * Walks forward from a transient until the tail decays into the noise floor.
 * Uses a percentile-estimated noise floor so a quiet room does not force a
 * one-second clip, and a hold window so a momentary dip does not truncate it.
 */
export function findTailEnd(
  samples: Float32Array,
  onsetSample: number,
  sampleRate: number,
  options: TailOptions,
): number {
  const { floorRatio, noiseMultiplier, holdDuration, maxDuration, minDuration } = options;
  const onset = Math.max(0, Math.floor(onsetSample));
  const maxEnd = Math.min(
    samples.length,
    onset + Math.round(sampleRate * maxDuration),
    options.endLimit ?? samples.length,
  );
  const minEnd = Math.min(maxEnd, onset + Math.round(sampleRate * minDuration));
  if (maxEnd - onset < 2) return maxEnd;

  const window = Math.max(8, Math.round(sampleRate * 0.003));
  const envelope = computeEnvelope(samples.subarray(onset, maxEnd), window);
  if (envelope.length === 0) return maxEnd;

  // Transient level, measured on a short burst right at the onset.
  const headCount = Math.min(
    envelope.length,
    Math.max(1, Math.round((0.006 * sampleRate) / window)),
  );
  let peakEnergy = 0;
  for (let i = 0; i < headCount; i++) peakEnergy = Math.max(peakEnergy, envelope[i]);
  if (peakEnergy <= 0) return maxEnd;

  // Robust noise floor: the lower quartile of the tail.
  const sorted = Float32Array.from(envelope).sort();
  const noiseFloor = sorted[Math.floor(sorted.length * 0.25)] ?? 0;

  const threshold = Math.max(peakEnergy * floorRatio, noiseFloor * noiseMultiplier);
  const holdWindows = Math.max(1, Math.round((holdDuration * sampleRate) / window));

  let lastLoud = -1;
  for (let i = 0; i < envelope.length; i++) {
    if (envelope[i] >= threshold) {
      lastLoud = i;
    } else if (lastLoud >= 0 && i - lastLoud > holdWindows) {
      break;
    }
  }

  if (lastLoud < 0) return minEnd;
  const end = onset + (lastLoud + 1 + holdWindows) * window;
  return Math.min(maxEnd, Math.max(minEnd, end));
}

export type CutOptions = {
  sampleRate: number;
  /** Silence kept before the detected transient. */
  leadIn: number;
  /** Hard ceiling on the exported clip length. */
  maxDuration: number;
  /** Floor of the transient, relative to its peak, used to find the tail. */
  tailFloor: number;
  fadeIn: number;
  fadeOut: number;
  normalize: boolean;
  /** Never amplify by more than this, so noise-only selections stay quiet. */
  maxGain: number;
  /** Move the clip start onto the strongest transient inside the selection. */
  snapOnset: boolean;
  /** End the clip where the tail decays into the noise floor. */
  trimTail: boolean;
  /** Apply the fade in and out. */
  fade: boolean;
};

/**
 * Everything switched on. Autocut uses this because it has to guess where a
 * click starts and stops, whereas a hand-made selection is honoured as drawn
 * unless the editor's toggles say otherwise.
 */
export const DEFAULT_CUT_OPTIONS: CutOptions = {
  sampleRate: 48000,
  leadIn: 0.012,
  maxDuration: 1.2,
  tailFloor: 0.02,
  fadeIn: 0.0015,
  fadeOut: 0.006,
  normalize: true,
  maxGain: 14,
  snapOnset: true,
  trimTail: true,
  fade: true,
};

/**
 * A hand-drawn selection, taken exactly as drawn. The three extras are opt-in so
 * that dragging over a click and saving gives back the click you heard.
 */
export const SELECTION_CUT_OPTIONS: CutOptions = {
  ...DEFAULT_CUT_OPTIONS,
  snapOnset: false,
  trimTail: false,
  normalize: false,
  fade: false,
};

/** The opt-in extras a user can switch on for a hand-drawn selection. */
export type CutBehavior = {
  snapOnset: boolean;
  trimTail: boolean;
  normalize: boolean;
  fade: boolean;
};

/** Everything off: what you drag is what you get. */
export const DEFAULT_CUT_BEHAVIOR: CutBehavior = {
  snapOnset: false,
  trimTail: false,
  normalize: false,
  fade: false,
};

export type Cut = {
  samples: Float32Array;
  /** Seconds from the start of the session to the start of the extracted clip. */
  start: number;
  end: number;
  gain: number;
  peakBefore: number;
};

/**
 * Extracts a clean, self-contained clip from a raw region of the session.
 *
 * The region is the user's selection and the clip never reaches outside it. What
 * happens inside it is up to the caller: by default a hand-drawn selection is
 * taken exactly as drawn, and each of the three extras is opt-in.
 */
export function cutSegment(
  session: Float32Array,
  sessionRate: number,
  fromSeconds: number,
  toSeconds: number,
  options: CutOptions = DEFAULT_CUT_OPTIONS,
): Cut | null {
  const rate = options.sampleRate;
  const scale = rate / sessionRate;

  const regionStart = Math.max(0, Math.floor(fromSeconds * sessionRate));
  const regionEnd = Math.min(session.length, Math.ceil(toSeconds * sessionRate));
  if (regionEnd - regionStart < Math.round(sessionRate * 0.01)) return null;

  // Default: honour the selection exactly, so what was dragged is what is saved.
  let clipStart = regionStart;
  if (options.snapOnset) {
    const onset = findOnset(session, regionStart, regionEnd, sessionRate);
    clipStart = Math.max(regionStart, onset - Math.round(options.leadIn * sessionRate));
  }

  // Default: run to the end of the selection. Trimming is opt-in, and even then
  // the decay point can never push the clip past what was selected.
  let clipEnd = regionEnd;
  if (options.trimTail) {
    clipEnd = findTailEnd(
      session,
      clipStart + Math.round(options.leadIn * sessionRate),
      sessionRate,
      {
        floorRatio: options.tailFloor,
        noiseMultiplier: 2.2,
        holdDuration: 0.02,
        maxDuration: options.maxDuration,
        minDuration: 0.05,
        endLimit: regionEnd,
      },
    );
  }

  const sourceEnd = Math.max(clipStart + 1, Math.min(session.length, clipEnd));
  const raw = session.subarray(clipStart, sourceEnd);

  const outLength = Math.max(1, Math.round(raw.length * scale));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const src = i / scale;
    const i0 = Math.floor(src);
    const i1 = Math.min(raw.length - 1, i0 + 1);
    const t = src - i0;
    out[i] = raw[i0] * (1 - t) + raw[i1] * t;
  }

  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));

  let gain = 1;
  if (options.normalize && peak > 1e-6) {
    gain = Math.min(options.maxGain, 0.92 / peak);
  }
  if (gain !== 1) {
    for (let i = 0; i < out.length; i++) out[i] *= gain;
  }

  if (options.fade) {
    applyFades(out, options.fadeIn * rate, options.fadeOut * rate);
  }

  return {
    samples: out,
    start: clipStart / sessionRate,
    end: sourceEnd / sessionRate,
    gain,
    peakBefore: peak,
  };
}

export function applyFades(samples: Float32Array, fadeIn: number, fadeOut: number) {
  const inLen = Math.min(samples.length, Math.max(0, Math.floor(fadeIn)));
  for (let i = 0; i < inLen; i++) samples[i] *= i / inLen;

  const outLen = Math.min(samples.length - inLen, Math.max(0, Math.floor(fadeOut)));
  for (let i = 0; i < outLen; i++) {
    const idx = samples.length - 1 - i;
    samples[idx] *= i / outLen;
  }
}
