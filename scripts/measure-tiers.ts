/*
 * Measures every clip in the SD1 reference pack so the intensity bands can be
 * picked from real numbers instead of guessed.
 *
 * The pack's folders are hand-graded, so they are the ground truth for what
 * "micro" / "soft" / "medium" / "hard" actually sound like. Everything measured
 * here is scale-free (a ratio, a duration, or a per-millisecond rate) because
 * exported clips are peak-normalised, so absolute level cannot separate the
 * tiers - only shape can.
 *
 * Run: node scripts/measure-tiers.ts
 */
import fs from "node:fs";
import path from "node:path";

import { decodeWav } from "../src/lib/audio/wav.ts";
import { fft } from "../src/lib/audio/fft.ts";
import { CATEGORIES } from "../src/lib/types.ts";

const PACK = path.resolve(import.meta.dirname, "..", process.argv[2] ?? "SD1");

/** Envelope resolution for decay measurement, in seconds. */
const ENV_WINDOW = 0.001;
/** Hold that keeps a momentary dip from ending a decay early, in seconds. */
const DECAY_HOLD = 0.003;

type Features = {
  file: string;
  tier: string;
  peakDb: number;
  /** Absolute peak, for reference only; exported clips are not always normalised. */
  peak: number;
  /** Noise floor from the clip's own quiet tail, as RMS. */
  floor: number;
  /** Attack RMS over the first 10 ms. */
  attack: number;
  /**
   * Attack prominence in dB: how far the click sits above its own noise floor.
   * This is the one figure that survives both mic gain and normalisation.
   */
  snrDb: number;
  /** peak / attackRMS. High for a spike-like tick, low for a body that fills. */
  crest: number;
  /** ms from the peak until the envelope falls into the noise floor. */
  decayMs: number;
  /** Zero crossings per ms in the first 5 ms after the peak; a brightness proxy. */
  zcr: number;
  /** Spectral centroid of the attack, in Hz. */
  centroid: number;
  /** Share of attack energy above 4 kHz. */
  hfFrac: number;
};

const toDb = (ratio: number) => 20 * Math.log10(Math.max(ratio, 1e-9));

function rms(samples: Float32Array, from: number, to: number): number {
  const start = Math.max(0, from);
  const end = Math.min(samples.length, to);
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / (end - start));
}

/** FFT size for the attack spectrum. */
const SPECTRUM_SIZE = 2048;
/** Split between a dull tap and a bright switch click. */
const HF_SPLIT_HZ = 4000;

/**
 * Centroid and high-frequency share of the attack. Timbre is the one dimension
 * left once level and duration overlap: a fingertip tap is dull, a palm strike
 * or a switch snap is bright.
 */
function spectrum(
  samples: Float32Array,
  from: number,
  rate: number,
): { centroid: number; hfFrac: number } {
  const re = new Float32Array(SPECTRUM_SIZE);
  const im = new Float32Array(SPECTRUM_SIZE);
  for (let i = 0; i < SPECTRUM_SIZE; i++) {
    const index = from + i;
    const sample = index >= 0 && index < samples.length ? samples[index]! : 0;
    re[i] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SPECTRUM_SIZE));
  }
  fft(re, im);

  const bins = SPECTRUM_SIZE / 2 + 1;
  const binHz = rate / SPECTRUM_SIZE;
  let weighted = 0;
  let total = 0;
  let hf = 0;
  for (let b = 1; b < bins; b++) {
    const magnitude = Math.hypot(re[b]!, im[b]!);
    const hz = b * binHz;
    weighted += magnitude * hz;
    total += magnitude;
    if (hz >= HF_SPLIT_HZ) hf += magnitude;
  }
  return {
    centroid: total > 0 ? weighted / total : 0,
    hfFrac: total > 0 ? hf / total : 0,
  };
}

function measure(file: string, tier: string, samples: Float32Array, rate: number): Features {
  const win = Math.max(1, Math.round(ENV_WINDOW * rate));

  let peak = 0;
  let peakIndex = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]!);
    if (value > peak) {
      peak = value;
      peakIndex = i;
    }
  }

  // Noise floor from the quiet half of the clip, measured in coarse windows so a
  // single dip does not define it. median, not mean, so a stray bump is ignored.
  const windows: number[] = [];
  for (let start = Math.floor(samples.length / 2); start < samples.length; start += win) {
    windows.push(rms(samples, start, start + win));
  }
  windows.sort((a, b) => a - b);
  const floor = windows.length ? windows[windows.length >> 1]! : 0;

  const attackRms = rms(samples, peakIndex, peakIndex + Math.round(0.01 * rate));

  // Decay: walk the sliding envelope forward until it is back inside the noise
  // floor, so the measurement ends where the clip's own background begins.
  let decayMs = 0;
  if (floor > 0) {
    const stop = floor * 3;
    let lastLoud = peakIndex;
    for (let start = peakIndex; start < samples.length; start += win) {
      if (rms(samples, start, start + win) >= stop) lastLoud = start;
      else if (start - lastLoud > DECAY_HOLD * rate) break;
    }
    decayMs = ((lastLoud - peakIndex) / rate) * 1000;
  }

  let crossings = 0;
  const zcrEnd = Math.min(samples.length, peakIndex + Math.round(0.005 * rate));
  for (let i = peakIndex + 1; i < zcrEnd; i++) {
    if (samples[i - 1]! <= 0 !== samples[i]! <= 0) crossings++;
  }

  const { centroid, hfFrac } = spectrum(samples, peakIndex, rate);

  return {
    file,
    tier,
    peakDb: toDb(peak),
    peak,
    floor,
    attack: attackRms,
    snrDb: toDb(attackRms / (floor + 1e-9)),
    crest: attackRms > 0 ? peak / attackRms : 0,
    decayMs,
    zcr: (crossings / rate / 0.005) * 1000,
    centroid,
    hfFrac,
  };
}

const rows: Features[] = [];
for (const category of CATEGORIES) {
  const dir = path.join(PACK, category.id);
  if (!fs.existsSync(dir)) {
    console.error(`missing tier folder: ${dir}`);
    continue;
  }
  for (const name of fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    if (!name.endsWith(".wav")) continue;
    const buffer = fs.readFileSync(path.join(dir, name));
    const decoded = decodeWav(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );
    if (!decoded) {
      console.error(`undecodable: ${category.id}/${name}`);
      continue;
    }
    rows.push(measure(name, category.id, decoded.samples, decoded.sampleRate));
  }
}

if (rows.length === 0) {
  console.error(`no clips found under ${PACK}`);
  process.exit(1);
}

const num = (value: number, digits = 2) => value.toFixed(digits);
const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const spread = (group: Features[], pick: (row: Features) => number, digits = 2) => {
  const values = group.map(pick);
  return `${num(median(values), digits)} [${num(Math.min(...values), digits)}-${num(Math.max(...values), digits)}]`;
};

console.log(`SD1 reference pack: ${rows.length} clips`);
console.log("median [min-max] per tier\n");
console.log(
  ["tier", "n", "peak dBFS", "SNR dB", "crest", "decay ms", "centroid", "hfFrac"]
    .map((h, i) => (i < 2 ? h.padEnd(15) : h.padStart(16)))
    .join(""),
);
console.log("-".repeat(15 + 16 * 5));

for (const category of CATEGORIES) {
  const group = rows.filter((row) => row.tier === category.id);
  if (group.length === 0) continue;
  console.log(
    [
      category.id.padEnd(15),
      String(group.length).padStart(16),
      spread(group, (r) => r.peakDb, 1).padStart(16),
      spread(group, (r) => r.snrDb, 1).padStart(16),
      spread(group, (r) => r.crest).padStart(16),
      spread(group, (r) => r.decayMs, 1).padStart(16),
      spread(group, (r) => r.centroid, 0).padStart(16),
      spread(group, (r) => r.hfFrac).padStart(16),
    ].join(""),
  );
}

console.log("\n--- every clip, sorted by tier then SNR ---");
console.log(
  ["tier", "file", "peak dBFS", "SNR dB", "crest", "decay ms", "centroid", "hfFrac"]
    .map((h, i) => (i < 2 ? h.padEnd(15) : h.padStart(11)))
    .join(""),
);
for (const category of CATEGORIES) {
  for (const row of rows
    .filter((r) => r.tier === category.id)
    .sort((a, b) => a.hfFrac - b.hfFrac)) {
    console.log(
      [
        row.tier.padEnd(15),
        row.file.padEnd(15),
        num(row.peakDb, 1).padStart(11),
        num(row.snrDb, 1).padStart(11),
        num(row.crest).padStart(11),
        num(row.decayMs, 1).padStart(11),
        num(row.centroid, 0).padStart(11),
        num(row.hfFrac).padStart(11),
      ].join(" "),
    );
  }
}
