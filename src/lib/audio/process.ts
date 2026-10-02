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

/**
 * Second-order high-pass over a sample range, returned as a new buffer.
 *
 * Desk rumble, HVAC and the low "body" thump under a switch are all low
 * frequency, and all of them can be louder than the click itself: a mouse
 * press's body is still ringing about 14 dB above its own lift 25 ms later.
 * Anything that has to measure the click rather than its furniture should do it
 * here.
 */
export function highPassSlice(samples: Float32Array, from: number, to: number): Float32Array {
  const size = Math.max(0, to - from);
  const out = new Float32Array(size);
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
    out[i] = stage2;
  }
  return out;
}

/**
 * High-passes a stretch of audio and takes its short-window RMS envelope.
 *
 * Both onset detectors work in this filtered domain, deliberately. A switch's
 * low "body" thump, desk rumble and HVAC can each be far louder than the click
 * itself - a mouse press's body is still ringing at -14 dB relative to its own
 * lift 25 ms later - so "the click" has to mean the part that survives a
 * high-pass, or a release gets measured as the press it is sitting inside.
 */
function highPassEnvelope(
  samples: Float32Array,
  from: number,
  to: number,
  sampleRate: number,
  envSeconds: number,
): { env: Float32Array; frame: number } {
  const size = Math.max(0, to - from);
  const frame = Math.max(4, Math.round(envSeconds * sampleRate));
  const frames = Math.max(1, Math.floor(size / frame));

  const filtered = highPassSlice(samples, from, from + size);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * frame;
    const end = Math.min(size, start + frame);
    for (let i = start; i < end; i++) sum += filtered[i]! * filtered[i]!;
    env[f] = Math.sqrt(sum / Math.max(1, end - start));
  }
  return { env, frame };
}

/**
 * Median absolute sample value over a take: the room it was recorded in.
 *
 * The median rather than the mean or the peak, so a take that is mostly silence,
 * mostly clicks, or any mixture of the two reports the room rather than the
 * clicks. Subsampled, because this is a level estimate and not worth reading
 * every sample of a long recording for.
 */
export function medianMagnitude(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  const step = Math.max(1, Math.floor(samples.length / 20000));
  const count = Math.ceil(samples.length / step);
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) values[i] = Math.abs(samples[i * step]!);
  return median(values);
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

  const { env, frame: window } = highPassEnvelope(samples, from, to, sampleRate, ONSET_ENV_WINDOW);
  const frames = env.length;

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

/**
 * Envelope resolution for release detection, in seconds. Coarser than the click
 * detector's: a lift is a tick, and its whole rise happens in about a frame, so a
 * finer envelope would only make it easier for noise on a decaying press tail to
 * pose as an attack.
 */
const RELEASE_ENV_WINDOW = 0.002;
/** A frame has to be this much above the one before it to count as a rise. */
const RELEASE_MIN_RISE = 1.25;
/** …and this much above the quietest the press tail has got, to count as a lift. */
const RELEASE_MIN_PROMINENCE = 1.6;
/** How far back from the bump's peak the attack is walked, in seconds. */
const RELEASE_ATTACK_SEARCH = 0.004;
/**
 * …and to what share of the bump's peak the envelope must fall before the attack
 * counts as started. A lift is a tick with a sharp rise, so a high threshold
 * keeps the walk from sliding back down the press's tail.
 */
const RELEASE_ATTACK_LEVEL = 0.35;
/** Below this the bump is judged to be noise riding the tail, not a lift. */
const RELEASE_MIN_CONFIDENCE = 0.2;

/**
 * Locates a lift on the decaying tail of the press that came before it.
 *
 * A release cannot be found the way a click is. `detectOnset` picks the
 * strongest transient in its window, and inside a release's window the strongest
 * transient is the press it is sitting on - so it reported the press's tail,
 * tens of milliseconds past the lift, at a confidence that looked plausible.
 * Worse, the window used to begin 25 ms after the press, which is after the lift
 * on any click faster than a deliberate one, so the lift was not in the window
 * at all.
 *
 * The lift is therefore found as a *rise out of a decay* instead of as a loud
 * spot. From just past the press attack the tail only falls, so the first frame
 * that climbs both above the frame before it and above the quietest the tail has
 * reached is the lift. When the press is still ringing hard enough to bury the
 * lift - a click held for under about 15 ms - there is no such frame and this
 * returns null, which is the honest answer: the two events have not separated
 * yet, and guessing would produce a clip of the press's tail wearing a
 * release's name.
 */
export function detectReleaseOnset(
  samples: Float32Array,
  startSample: number,
  endSample: number,
  sampleRate: number,
): OnsetHit | null {
  const from = Math.max(0, Math.floor(startSample));
  const to = Math.min(samples.length, Math.ceil(endSample));
  if (to - from < 16) return null;

  const { env, frame } = highPassEnvelope(samples, from, to, sampleRate, RELEASE_ENV_WINDOW);
  if (env.length < 4) return null;

  // --- first rise clear of the decaying tail ---
  let floor = Infinity;
  let bump = -1;
  let floorAtBump = 0;
  for (let f = 1; f < env.length; f++) {
    const previous = env[f - 1]!;
    if (previous < floor) floor = previous;
    if (
      bump < 0 &&
      env[f]! > previous * RELEASE_MIN_RISE &&
      env[f]! > Math.max(floor * RELEASE_MIN_PROMINENCE, previous)
    ) {
      bump = f;
      floorAtBump = floor;
    }
  }
  if (bump < 0 || floorAtBump <= 0) return null;

  // --- the bump's own peak, and how far it stands out from the tail ---
  const peakSpan = Math.max(1, Math.round(ONSET_PEAK_WINDOW * sampleRate));
  let peakFrame = bump;
  let bumpPeak = env[bump]!;
  while ((peakFrame + 1) * frame + peakSpan < from + env.length * frame) {
    const next = env[peakFrame + 1]!;
    if (next <= bumpPeak) break;
    peakFrame += 1;
    bumpPeak = next;
  }
  const prominence = bumpPeak / floorAtBump;
  const confidence = Math.max(0, Math.min(1, Math.log2(prominence) / CONFIDENCE_OCTAVES));
  if (confidence < RELEASE_MIN_CONFIDENCE) return null;

  // --- walk back to where the lift's own rise began ---
  const level = bumpPeak * RELEASE_ATTACK_LEVEL;
  const backLimit = Math.max(0, peakFrame - Math.ceil((RELEASE_ATTACK_SEARCH * sampleRate) / frame));
  let attackFrame = peakFrame;
  while (attackFrame > Math.max(bump - 1, backLimit)) {
    if (env[attackFrame - 1]! < level) break;
    attackFrame -= 1;
  }

  const attack = from + attackFrame * frame;
  const bodyEnd = from + Math.round(peakFrame * frame) + peakSpan;
  return {
    sample: attack,
    peak: Math.max(bumpPeak, peakIn(samples, attack, bodyEnd)),
    rms: rmsIn(samples, attack, bodyEnd),
    confidence,
  };
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
 * How far into the region the transient level is measured, in seconds.
 *
 * Not just the first few milliseconds: a hand-drawn selection routinely starts
 * well before the click it was drawn around, and cutSegment passes the start of
 * the region rather than a measured attack. Measuring the leading silence sets
 * the threshold from the room instead of the click, which makes the
 * `maxThresholdRatio` cap bind *below* the noise floor - nothing then ever reads
 * as quiet, the tail search runs to the end of the selection, and trimming is
 * silently a no-op. Looking a little way in finds the click wherever in the
 * opening stretch of the region it actually sits.
 */
const PEAK_SEARCH = 0.03;

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

  // Transient level, taken from the loudest part of the opening stretch so a
  // selection that begins before its click still measures the click.
  const searchCount = Math.min(
    envelope.length,
    Math.max(1, Math.round((PEAK_SEARCH * sampleRate) / window)),
  );
  let peakEnergy = 0;
  for (let i = 0; i < searchCount; i++) peakEnergy = Math.max(peakEnergy, envelope[i]!);
  if (peakEnergy <= 0) return maxEnd;

  // Robust noise floor: a low percentile of the tail, with the attack excluded.
  // Using the lower quartile over the whole region let the click itself set the
  // floor, which pulled the threshold up into the decay.
  const noiseFloor = percentile(envelope.subarray(searchCount), 0.2);

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
