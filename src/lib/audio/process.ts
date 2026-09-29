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

/** Upper bound on the second-order high-pass coefficient. */
const HIGHPASS_A = 0.88;
/** Envelope resolution for onset detection, in seconds. */
const ONSET_ENV_WINDOW = 0.0003;
/** The click has to reach this share of the window's loudest frame to count. */
const ONSET_MIN_REACH = 0.08;
/** …and this multiple of the window's background, so room noise is not a click. */
const ONSET_MIN_SNR = 4;
/** How far back the attack start is searched from the flux peak, in seconds. */
const ONSET_ATTACK_SEARCH = 0.004;
/** Window used to measure the click's own peak, in seconds. */
const ONSET_PEAK_WINDOW = 0.012;
/** Log-floor, so silence does not produce a division by zero. */
const LOG_EPS = 1e-9;
/**
 * Octaves of peak-over-background that count as a fully confident transient.
 * A mechanical click sits 40-60 dB above a quiet room, i.e. 7-10 octaves.
 */
const CONFIDENCE_OCTAVES = 8;

/** Cheap percentile of a copy. `fraction` is 0..1. */
function percentile(values: Float32Array, fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * fraction)));
  return sorted[index] ?? 0;
}

function median(values: Float32Array): number {
  return percentile(values, 0.5);
}

/** Largest absolute sample in a range. */
function peakIn(samples: Float32Array, from: number, to: number): number {
  let peak = 0;
  const end = Math.min(samples.length, to);
  for (let i = Math.max(0, from); i < end; i++) {
    const value = Math.abs(samples[i]!);
    if (value > peak) peak = value;
  }
  return peak;
}

/** Root-mean-square level in a range. */
function rmsIn(samples: Float32Array, from: number, to: number): number {
  const start = Math.max(0, from);
  const end = Math.min(samples.length, to);
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / (end - start));
}

export type OnsetHit = {
  /** Sample index where the attack starts, not where the flux peaks. */
  sample: number;
  /** Absolute peak of the click's own body. */
  peak: number;
  /** RMS of the click's own body, a steadier loudness measure than the peak. */
  rms: number;
  /** 0..1 measure of how transient-like the window is. */
  confidence: number;
};

/**
 * Locates a click's attack inside a window.
 *
 * Two things make this more accurate than picking the loudest energy frame:
 *
 * 1. A second-order high-pass is applied first. Desk rumble and HVAC are
 *    low-frequency and can easily be louder than the click, but a switch and a
 *    keycap both live far above 1 kHz, so the click is what survives.
 * 2. The transient is picked from log-domain energy *flux* - how fast the
 *    envelope rises - rather than from envelope height. That finds the attack
 *    itself and not the loudest point of the decay, and it is scale invariant,
 *    so a soft tap and a hard slam are timed the same way.
 *
 * The returned sample is then walked back to where the envelope leaves
 * `ONSET_ATTACK_LEVEL` of the click's own peak, so it points at the start of
 * the attack. That is what a lead-in has to be measured from: reporting the
 * flux peak instead would bury the first couple of milliseconds of the click.
 */
export function detectOnset(
  samples: Float32Array,
  startSample: number,
  endSample: number,
  sampleRate: number,
): OnsetHit | null {
  const from = Math.max(0, Math.floor(startSample));
  const to = Math.min(samples.length, Math.ceil(endSample));
  if (to - from < 8) return null;

  // --- second-order high-pass, run in place over a scratch copy ---
  const size = to - from;
  const filtered = new Float32Array(size);
  let stage1 = 0;
  let stage1PrevIn = 0;
  let stage2 = 0;
  let stage2PrevIn = 0;
  for (let i = 0; i < size; i++) {
    const x = samples[from + i]!;
    stage1 = HIGHPASS_A * (stage1 + x - stage1PrevIn);
    stage1PrevIn = x;
    stage2 = HIGHPASS_A * (stage2 + stage1 - stage2PrevIn);
    stage2PrevIn = stage1;
    filtered[i] = stage2;
  }

  // --- short envelope, one value per ONSET_ENV_WINDOW ---
  const window = Math.max(4, Math.round(ONSET_ENV_WINDOW * sampleRate));
  const frames = Math.max(1, Math.floor(size / window));
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * window;
    const end = Math.min(size, start + window);
    for (let i = start; i < end; i++) sum += filtered[i]! * filtered[i]!;
    env[f] = Math.sqrt(sum / Math.max(1, end - start));
  }

  let envMax = 0;
  for (let f = 0; f < frames; f++) if (env[f]! > envMax) envMax = env[f]!;
  if (envMax <= 0) return null;

  // The window's own background, used to reject a stretch of room noise. Without
  // this gate a silent stretch still has a loudest frame, and the search would
  // hand back a confident-looking marker sitting in the middle of nothing.
  const background = median(env);
  if (envMax < background * ONSET_MIN_SNR) return null;

  // --- log-domain flux, so amplitude does not change which attack wins ---
  const reach = Math.max(envMax * ONSET_MIN_REACH, background * 2);
  let best = -1;
  let bestFlux = -Infinity;
  let bestValue = 0;
  for (let f = 1; f < frames; f++) {
    if (env[f]! < reach) continue;
    const previous = Math.log(env[f - 1]! + LOG_EPS);
    const current = Math.log(env[f]! + LOG_EPS);
    const flux = current - previous;
    if (flux > bestFlux) {
      bestFlux = flux;
      best = f;
      bestValue = env[f]!;
    }
  }
  if (best < 0) return null;

  // --- parabolic interpolation for sub-frame accuracy ---
  let peakFrame = best;
  if (best > 0 && best < frames - 1) {
    const a = Math.log(env[best - 1]! + LOG_EPS);
    const b = Math.log(env[best]! + LOG_EPS);
    const c = Math.log(env[best + 1]! + LOG_EPS);
    const denominator = a - 2 * b + c;
    if (Math.abs(denominator) > 1e-12) {
      const shift = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denominator));
      peakFrame = best + shift;
    }
  }

  // --- the click's own peak, not the next event's ---
  const peakSpan = Math.max(1, Math.round(ONSET_PEAK_WINDOW * sampleRate));
  const localMax = Math.max(
    bestValue,
    peakIn(samples, from + best * window, from + best * window + peakSpan),
  );

  // --- walk back to the attack's leading edge ---
  // The envelope has to climb all the way back to the candidate gate before the
  // attack is considered to have started. Stopping at the first quiet frame
  // instead would report the loudest point of the decay - or, on a click whose
  // second stage is louder than its first, its second stage - and land the
  // marker several milliseconds late.
  const backLimit = Math.max(0, best - Math.ceil((ONSET_ATTACK_SEARCH * sampleRate) / window));
  let attackFrame = best;
  while (attackFrame > backLimit) {
    const previous = env[attackFrame - 1]!;
    if (previous < reach && previous < background * 1.5) break;
    attackFrame -= 1;
  }
  const attack = from + attackFrame * window;

  const ratio = localMax / (background + LOG_EPS);
  const confidence = Math.max(0, Math.min(1, Math.log2(ratio) / CONFIDENCE_OCTAVES));

  const bodyEnd = from + Math.round(peakFrame * window) + peakSpan;
  return {
    sample: attack,
    peak: localMax,
    rms: rmsIn(samples, attack, bodyEnd),
    confidence,
  };
}

/**
 * Locates the strongest transient inside a window, for a hand-drawn selection
 * that still has to snap to something. Returns a sample index, matching the
 * shape of the old RMS-based picker but using the high-passed detector so a
 * click is not beaten by the rumble around it.
 */
export function findOnset(
  samples: Float32Array,
  startSample: number,
  endSample: number,
  sampleRate: number,
): number {
  const hit = detectOnset(samples, startSample, endSample, sampleRate);
  return hit ? hit.sample : Math.max(0, Math.floor(startSample));
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
  /**
   * The tail threshold may never sit above this share of the transient, however
   * loud the room is. Without the cap a noisy take puts its floor at 30% of the
   * click, the threshold follows, and every clip is truncated a millisecond
   * after the attack - which is exactly what a cut-off click sounds like.
   */
  maxThresholdRatio?: number;
  /**
   * Audio kept after the decay drops below the threshold, so the exported clip
   * always ends in a real tail rather than on the threshold crossing. ZCB takes
   * the second half of a body as its resonance ring, so a clipped tail plays
   * back as silence.
   */
  minTailDuration?: number;
};

/** Default cap on the tail threshold, as a share of the transient peak. */
const DEFAULT_MAX_THRESHOLD_RATIO = 0.3;
/** Default silence kept after the decay falls below the threshold. */
const DEFAULT_MIN_TAIL_DURATION = 0.02;

/**
 * Walks forward from a transient until the tail decays into the noise floor.
 *
 * The floor is estimated from the tail only - the attack is excluded, because
 * including it drags the estimate up and shortens every clip - and the
 * resulting threshold is capped relative to the transient so a loud room can
 * never turn the tail search into a hard cut. A hold window keeps a momentary
 * dip from truncating the decay.
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
  for (let i = 0; i < headCount; i++) peakEnergy = Math.max(peakEnergy, envelope[i]!);
  if (peakEnergy <= 0) return maxEnd;

  // Robust noise floor: a low percentile of the tail, with the attack excluded.
  // Using the lower quartile over the whole region let the click itself set the
  // floor, which pulled the threshold up into the decay.
  const noiseFloor = percentile(envelope.subarray(headCount), 0.2);

  const threshold = Math.min(
    Math.max(peakEnergy * floorRatio, noiseFloor * noiseMultiplier),
    peakEnergy * (options.maxThresholdRatio ?? DEFAULT_MAX_THRESHOLD_RATIO),
  );
  const tailHold = Math.max(holdDuration, options.minTailDuration ?? DEFAULT_MIN_TAIL_DURATION);
  const holdWindows = Math.max(1, Math.round((tailHold * sampleRate) / window));

  let lastLoud = -1;
  for (let i = 0; i < envelope.length; i++) {
    if (envelope[i]! >= threshold) {
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
  // Kept sub-perceptual. The 1.5 ms fade below already stops the clip starting on
  // a hard digital edge, so any real lead-in is only added latency in front of
  // the click rather than protection.
  leadIn: 0.0015,
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
 * Tail-search settings shared by both cut paths.
 *
 * The hold is short - 12 ms - because a click's tail is the part that has to
 * survive. A long hold cannot truncate a dip any worse, it only adds silence to
 * every exported clip, and silence is room noise that the denoiser then has to
 * remove. The floor cap does the work that protects the decay from a loud room.
 */
const TAIL_SETTINGS = {
  floorRatio: DEFAULT_CUT_OPTIONS.tailFloor,
  noiseMultiplier: 2.2,
  holdDuration: 0.012,
  minTailDuration: 0.012,
  maxThresholdRatio: 0.3,
  minDuration: 0.03,
} as const;

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
 * Resamples a session range to the target rate, normalises and fades it. Shared
 * by every cut so a clip produced from a known onset and one produced from a
 * hand-drawn selection are processed identically.
 */
function extract(
  session: Float32Array,
  sessionRate: number,
  clipStart: number,
  clipEnd: number,
  options: CutOptions,
): Cut {
  const rate = options.sampleRate;
  const scale = rate / sessionRate;
  const sourceEnd = Math.max(clipStart + 1, Math.min(session.length, clipEnd));
  const raw = session.subarray(clipStart, sourceEnd);

  const outLength = Math.max(1, Math.round(raw.length * scale));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const src = i / scale;
    const i0 = Math.floor(src);
    const i1 = Math.min(raw.length - 1, i0 + 1);
    const t = src - i0;
    out[i] = raw[i0]! * (1 - t) + raw[i1]! * t;
  }

  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));

  let gain = 1;
  if (options.normalize && peak > 1e-6) {
    gain = Math.min(options.maxGain, 0.92 / peak);
  }
  if (gain !== 1) {
    for (let i = 0; i < out.length; i++) out[i]! *= gain;
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
      { ...TAIL_SETTINGS, maxDuration: options.maxDuration, endLimit: regionEnd },
    );
  }

  return extract(session, sessionRate, clipStart, clipEnd, options);
}

/**
 * Cuts a clip around an onset that has already been located, stopping at
 * `endLimitSample`.
 *
 * Autocut uses this instead of `cutSegment` because it has to reason about every
 * event in the take at once. The onset comes from a real transient measurement
 * rather than a second guess inside a selection, and `endLimitSample` is the
 * point past which the next event owns the audio - so a press can never eat the
 * release that follows it, or vice versa.
 */
export function cutFromOnset(
  session: Float32Array,
  sessionRate: number,
  onsetSample: number,
  endLimitSample: number,
  options: CutOptions = DEFAULT_CUT_OPTIONS,
): Cut | null {
  const onset = Math.max(0, Math.min(session.length - 1, Math.floor(onsetSample)));
  const leadIn = Math.round(options.leadIn * sessionRate);
  const clipStart = Math.max(0, onset - leadIn);
  const ceiling = Math.min(
    session.length,
    Math.floor(endLimitSample),
    clipStart + Math.round(options.maxDuration * sessionRate),
  );
  if (ceiling - clipStart < Math.round(sessionRate * 0.01)) return null;

  const clipEnd = options.trimTail
    ? findTailEnd(session, onset, sessionRate, {
        ...TAIL_SETTINGS,
        floorRatio: options.tailFloor,
        maxDuration: options.maxDuration,
        endLimit: ceiling,
      })
    : ceiling;

  return extract(session, sessionRate, clipStart, clipEnd, options);
}

/**
 * Fades the clip edges. The two ramps are kept from overlapping so a very short
 * clip is faded once, not twice, which would dim the whole thing.
 */
export function applyFades(samples: Float32Array, fadeIn: number, fadeOut: number) {
  const inLen = Math.min(samples.length, Math.max(0, Math.floor(fadeIn)));
  for (let i = 0; i < inLen; i++) samples[i]! *= i / inLen;

  const outLen = Math.min(samples.length - inLen, Math.max(0, Math.floor(fadeOut)));
  for (let i = 0; i < outLen; i++) {
    const idx = samples.length - 1 - i;
    samples[idx]! *= i / outLen;
  }
}
