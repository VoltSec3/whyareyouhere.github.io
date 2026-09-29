import { fft, ifft } from "./fft";

/**
 * Background-noise suppression for exported click clips.
 *
 * Both methods are the same spectral gate; they differ in where the noise
 * profile comes from:
 *
 * - `live`     estimates the floor from the clip's own quiet frames (a low
 *              percentile per frequency bin). Works with no noise recording.
 * - `spectral` uses the profile measured from the supplied noise file, scaled by
 *              the clip's stored normalisation gain so both are compared in real
 *              room-level terms rather than guesses.
 *
 * Transient safety, in order of importance:
 *   1. The click's own body is located in the time domain and never gated. A
 *      click clip is trimmed to start on the attack, so it contains no leading
 *      silence to hide in and any frame-based heuristic alone will chew into it.
 *   2. Only magnitudes are scaled, never phase, so each frame's waveform shape
 *      survives.
 *   3. Gains never exceed 1, so a click can only be left alone or reduced.
 *   4. A broadband guard skips gating on frames far louder than the estimated
 *      floor, which catches onsets the body detector missed.
 *   5. Fast-attack / slow-release smoothing opens the gate instantly on an onset
 *      (no smearing) but eases it shut afterwards (no pumping).
 */

export type DenoiseMethod = "live" | "spectral";

/** Per-bin mean magnitude of the noise recording, in that recording's own units. */
export type NoiseShape = Float32Array;

const FRAME_SIZE = 1024;
const HOP_SIZE = 256;
/** Coarser stride when profiling a long noise recording; only the mean matters. */
const NOISE_HOP = 512;
const BINS = FRAME_SIZE / 2 + 1;
const HALF = FRAME_SIZE / 2;

/**
 * A bin must sit this many times above the estimated floor to be left alone.
 *
 * The floor is the *average* noise level of the clip, which is what makes this
 * ratio meaningful: a bin of the background sits at about 1.0 by definition, and
 * per-bin magnitudes are Rayleigh-distributed around it, so at 2.6 only about 1%
 * of noise bins escape untouched. The rest are pulled down, and the click - whose
 * bins sit two or three orders of magnitude above the room - is not among them.
 */
const SNR_THRESHOLD = 2.6;
/** Residual gain applied to fully-gated bins (-26 dB). */
const ATTENUATION = 0.05;
/** A frame this many times louder than the floor is a transient, not noise. */
const TRANSIENT_RATIO = 2.5;
/**
 * …or one this many times louder than the floor's average bin, measured as a
 * single-bin spike. Compared against the average rather than the floor's own
 * loudest bin, because the loudest bin of a noise frame is several times the
 * average on its own: referencing the peak of the profile made every noise frame
 * look like a transient and the gate never closed.
 */
const PEAK_GUARD_RATIO = 12;
/**
 * How quickly the floor follows the room when it gets louder, per frame. The
 * click is protected explicitly by the body detector, so this only ever reacts to
 * the background: someone walks past, a fan spins up, the gate tightens, and it
 * relaxes again once the room settles. Slower than the release below on purpose,
 * because a floor that chases every wobble is what makes a gate sound like a
 * pump rather than like noise going away.
 */
const FLOOR_TRACK_RATE = 0.04;
/** Bounds on that tracking, so one very loud frame cannot swamp the floor. */
const FLOOR_TRACK_MIN = 0.5;
const FLOOR_TRACK_MAX = 6;
/** Bins either side used when smoothing the gain across frequency. */
const SMOOTH_RADIUS = 2;
/**
 * Smoothing widens with frequency, because a fixed narrow window leaves isolated
 * gated bins behind and they are heard as a metallic warble. A wider window at
 * the top averages neighbouring bins together and keeps the noise smooth.
 */
const SMOOTH_RADIUS_PER_DECADE = 6;
/** Upper bound on the widening above. */
const MAX_SMOOTH_RADIUS = 6;
/** Frames to ease the gain closed. */
const RELEASE_FRAMES = 6;
/** Frames between UI yields so the progress bar can paint. */
const YIELD_EVERY = 16;
/**
 * The click body is protected down to this fraction of its own peak envelope.
 * This is the one that decides whether the exported click sounds truncated: a
 * decay that is still audible sits well below 8% of the attack, and gating it is
 * what produces a click that stops dead a millisecond after it starts.
 */
const PROTECT_FLOOR = 0.012;
/** Envelope resolution for body detection, in seconds. */
const ENV_WINDOW = 0.001;
/**
 * A two-stage mechanical click dips between the main strike and the spring
 * release, so the body end is the last envelope above the floor *with a hold*,
 * rather than the last one that clears it.
 */
const PROTECT_HOLD = 0.008;
/** Extra protection past the detected body, in seconds. */
const PROTECT_MARGIN = 0.004;
const EPS = 1e-12;

export type DenoiseOptions = {
  method: DenoiseMethod;
  sampleRate: number;
  /** Required for `spectral`; ignored otherwise. */
  noiseShape?: NoiseShape | null;
  /**
   * Peak-normalisation gain the clip was stored with. Lets `spectral` compare
   * the clip against the noise file in the same absolute units.
   */
  storedGain?: number | null;
  onProgress?: (fraction: number) => void;
};

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Periodic Hann. Correct choice for overlap-add STFT analysis and synthesis. */
function hannWindow(): Float32Array {
  const window = new Float32Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME_SIZE);
  }
  return window;
}

/**
 * Gain smoothing radius per bin, widening with frequency.
 *
 * A fixed narrow window leaves isolated gated bins behind between louder ones,
 * and those are heard as a metallic warble that no amount of noise removal
 * justifies. Widening with frequency averages each bin with more of its
 * neighbours where the bins are closer together in pitch.
 */
function smoothingRadius(bin: number): number {
  const octaves = bin / (BINS - 1);
  return Math.min(MAX_SMOOTH_RADIUS, SMOOTH_RADIUS + Math.round(octaves * SMOOTH_RADIUS_PER_DECADE));
}

function smoothBins(bins: Float32Array, radius: number | ((bin: number) => number)): Float32Array {
  const out = new Float32Array(bins.length);
  for (let i = 0; i < bins.length; i++) {
    const width = typeof radius === "function" ? radius(i) : radius;
    let sum = 0;
    let count = 0;
    for (let k = -width; k <= width; k++) {
      const j = i + k;
      if (j < 0 || j >= bins.length) continue;
      sum += bins[j]!;
      count += 1;
    }
    out[i] = sum / count;
  }
  return out;
}

function mean(bins: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < bins.length; i++) sum += bins[i]!;
  return bins.length ? sum / bins.length : 0;
}

function loadFrame(
  buffer: Float32Array,
  start: number,
  window: Float32Array,
  re: Float32Array,
  im: Float32Array,
): void {
  for (let i = 0; i < FRAME_SIZE; i++) {
    const index = start + i;
    const sample = index >= 0 && index < buffer.length ? buffer[index]! : 0;
    re[i] = sample * window[i]!;
    im[i] = 0;
  }
}

function frameOffsets(length: number, hop: number): number[] {
  const count = Math.max(1, Math.ceil((length - FRAME_SIZE) / hop) + 1);
  const offsets: number[] = [];
  for (let f = 0; f < count; f++) offsets.push(f * hop);
  return offsets;
}

/**
 * Locates the click's own body from the amplitude envelope. Clips are trimmed to
 * begin on the attack, so this is what separates "the transient" from "the
 * background" - there is no leading silence to rely on.
 *
 * The floor is deliberately low and the search tolerates a short dip, because a
 * mechanical click is not one shape. The strike, the plate settling and the
 * spring coming back are separate events, and between them the envelope falls
 * most of the way to the room. A detector that stopped at the first quiet moment
 * would hand the rest of the decay to the noise gate, and the exported click
 * would end abruptly in playback.
 */
export function findClickBody(
  samples: Float32Array,
  sampleRate: number,
): { start: number; end: number } {
  if (samples.length === 0) return { start: 0, end: 0 };

  const win = Math.max(1, Math.round(ENV_WINDOW * sampleRate));
  const env = new Float32Array(samples.length);
  let peak = 0;
  let peakIndex = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]!;
    sum += value * value;
    if (i >= win) {
      const old = samples[i - win]!;
      sum -= old * old;
    }
    const level = Math.sqrt(sum / Math.min(i + 1, win));
    env[i] = level;
    if (level > peak) {
      peak = level;
      peakIndex = i;
    }
  }
  if (peak <= 0) return { start: 0, end: samples.length };

  const threshold = peak * PROTECT_FLOOR;
  const hold = Math.round(PROTECT_HOLD * sampleRate);
  let end = peakIndex;
  let lastLoud = peakIndex;
  for (let i = peakIndex; i < samples.length; i++) {
    if (env[i]! > threshold) {
      end = i;
      lastLoud = i;
    } else if (i - lastLoud > hold) {
      break;
    }
  }

  const margin = Math.round(PROTECT_MARGIN * sampleRate);
  return { start: 0, end: Math.min(samples.length, end + margin) };
}

/** Mean magnitude spectrum of a pure-noise recording, left in its own units. */
export function buildNoiseShape(noiseSamples: Float32Array): NoiseShape {
  const shape = new Float32Array(BINS);
  if (noiseSamples.length < FRAME_SIZE) return shape;

  const window = hannWindow();
  const re = new Float32Array(FRAME_SIZE);
  const im = new Float32Array(FRAME_SIZE);
  const hop = noiseSamples.length > FRAME_SIZE * 8 ? NOISE_HOP : HOP_SIZE;
  const offsets = frameOffsets(noiseSamples.length, hop);

  for (const offset of offsets) {
    loadFrame(noiseSamples, offset, window, re, im);
    fft(re, im);
    for (let b = 0; b < BINS; b++) shape[b] = shape[b]! + Math.hypot(re[b]!, im[b]!);
  }
  for (let b = 0; b < BINS; b++) shape[b] = shape[b]! / offsets.length;
  return smoothBins(shape, smoothingRadius);
}

/**
 * Noise floor estimated from the clip's own frames that do not contain the click
 * body: the per-bin average magnitude of that background.
 *
 * Earlier versions used one percentile of the quiet frames, and a running
 * minimum over them. Both put the floor well *below* the average noise level - a
 * low percentile lands at the bottom of the Rayleigh distribution, and a minimum
 * lower still - so a background bin measured against it read as signal and the
 * gate barely closed. The floor has to be the average level for "times above the
 * floor" to mean anything, and the frames that hold the click are excluded so the
 * click cannot raise its own floor.
 */
function liveProfile(
  samples: Float32Array,
  window: Float32Array,
  body: { start: number; end: number },
): Float32Array {
  const profile = new Float32Array(BINS);
  if (samples.length === 0) return profile;

  const offsets = frameOffsets(samples.length, HOP_SIZE);
  let usable = offsets.filter(
    (offset) => !(offset < body.end && offset + FRAME_SIZE > body.start),
  );
  // A long click can cover every frame; fall back to its quietest tail.
  if (usable.length < 3) {
    const tail = offsets.slice(Math.floor(offsets.length * 0.75));
    usable = tail.length >= 3 ? tail : offsets;
  }
  // Clips are capped well below this, but stay safe on an unexpected long buffer.
  const stride = Math.max(1, Math.ceil(usable.length / 600));
  usable = usable.filter((_, i) => i % stride === 0);

  const re = new Float32Array(FRAME_SIZE);
  const im = new Float32Array(FRAME_SIZE);
  for (const offset of usable) {
    loadFrame(samples, offset, window, re, im);
    fft(re, im);
    for (let b = 0; b < BINS; b++) profile[b] = profile[b]! + Math.hypot(re[b]!, im[b]!);
  }
  const frames = Math.max(1, usable.length);
  for (let b = 0; b < BINS; b++) profile[b] = profile[b]! / frames;
  return smoothBins(profile, smoothingRadius);
}

function resolveProfile(live: Float32Array, options: DenoiseOptions): Float32Array {
  const shape = options.noiseShape;
  if (options.method !== "spectral" || !shape || shape.length !== BINS) return live;

  // Undo the stored peak normalisation so the noise file and the clip are
  // compared at the same absolute level. Without a known gain there is nothing
  // to anchor to, so fall back to the clip's own estimate - which is what
  // `live` uses.
  const gain = options.storedGain;
  if (!gain || !Number.isFinite(gain) || gain <= 0) return live;

  const profile = new Float32Array(BINS);
  for (let b = 0; b < BINS; b++) profile[b] = shape[b]! / gain;
  return smoothBins(profile, smoothingRadius);
}

export async function denoiseSamples(
  samples: Float32Array,
  options: DenoiseOptions,
): Promise<Float32Array> {
  const { onProgress } = options;
  if (samples.length === 0) return samples;

  const window = hannWindow();
  const body = findClickBody(samples, options.sampleRate);
  const profile = resolveProfile(liveProfile(samples, window, body), options);
  const profileMean = mean(profile);

  // Zero-pad by a full frame so the first and last real samples are covered by
  // Hann windows near their peak. Without this the window is ~0 there and the
  // divide-by-weight step explodes.
  const pad = FRAME_SIZE;
  const total = samples.length + pad * 2;
  const padded = new Float32Array(total);
  padded.set(samples, pad);
  const bodyEndPadded = pad + body.end;

  const output = new Float32Array(total);
  const weight = new Float32Array(total);
  const re = new Float32Array(FRAME_SIZE);
  const im = new Float32Array(FRAME_SIZE);
  const magnitude = new Float32Array(BINS);
  const target = new Float32Array(BINS);
  const applied = new Float32Array(BINS).fill(1);
  const release = 1 / RELEASE_FRAMES;
  const offsets = frameOffsets(total, HOP_SIZE);
  // How much louder than the floor the room currently is. One figure rather than
  // one per bin: the click is handled separately, and the background either is
  // louder than it was or it is not.
  let floorScale = 1;

  for (let f = 0; f < offsets.length; f++) {
    const start = offsets[f]!;
    loadFrame(padded, start, window, re, im);
    fft(re, im);

    let sum = 0;
    let peak = 0;
    for (let b = 0; b < BINS; b++) {
      const m = Math.hypot(re[b]!, im[b]!);
      magnitude[b] = m;
      sum += m;
      if (m > peak) peak = m;
    }
    // Any frame that touches the click body is passed through untouched.
    const inBody = start < bodyEndPadded && start + FRAME_SIZE > pad;
    // Two ways of spotting an onset the body detector missed: broadband energy
    // well over the floor, or one bin far above the floor's average level.
    const level = sum / BINS;
    const loud = level > profileMean * TRANSIENT_RATIO || peak > profileMean * PEAK_GUARD_RATIO;

    // Let the floor follow the room, but only on frames the gate is allowed to
    // act on, so a louder room tightens the gate without a click loosening it.
    if (!inBody && !loud && profileMean > 0) {
      const wanted = Math.max(FLOOR_TRACK_MIN, Math.min(FLOOR_TRACK_MAX, level / profileMean));
      floorScale += (wanted - floorScale) * FLOOR_TRACK_RATE;
    }

    for (let b = 0; b < BINS; b++) {
      if (inBody || loud) {
        target[b] = 1;
        continue;
      }
      const snr = magnitude[b]! / ((profile[b]! * floorScale) + EPS);
      target[b] =
        snr >= SNR_THRESHOLD
          ? 1
          : ATTENUATION + (1 - ATTENUATION) * (snr / SNR_THRESHOLD) ** 2;
    }
    const smoothed = smoothBins(target, smoothingRadius);

    for (let b = 0; b < BINS; b++) {
      const want = smoothed[b]!;
      const previous = applied[b]!;
      // Open instantly so an onset is never clipped, close gently so the
      // background decays smoothly instead of pumping.
      const gain = want > previous ? want : previous + (want - previous) * release;
      applied[b] = gain;

      // Scale the bin itself, not its magnitude. Re-deriving the bin from
      // `magnitude * gain / magnitude` would flatten every bin to unit gain.
      re[b] = re[b]! * gain;
      im[b] = im[b]! * gain;
      // Re-impose the conjugate symmetry the inverse transform assumes, so the
      // partner bin cannot keep a different gain.
      if (b > 0 && b < HALF) {
        const mirror = FRAME_SIZE - b;
        re[mirror] = re[b]!;
        im[mirror] = -im[b]!;
      }
    }

    ifft(re, im);

    for (let i = 0; i < FRAME_SIZE; i++) {
      const index = start + i;
      if (index >= total) break;
      const w = window[i]!;
      output[index] = output[index]! + re[i]! * w;
      weight[index] = weight[index]! + w * w;
    }

    if ((f + 1) % YIELD_EVERY === 0) {
      onProgress?.((f + 1) / offsets.length);
      await nextTick();
    }
  }

  onProgress?.(1);

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const w = weight[pad + i]!;
    out[i] = w > 1e-6 ? output[pad + i]! / w : samples[i]!;
  }
  return out;
}
