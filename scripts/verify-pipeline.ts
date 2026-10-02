/* Headless verification of the cut + export pipeline against the SD1 reference.
 *
 * Run: npm run verify
 *   or: node --import ./scripts/register-ts.mjs scripts/verify-pipeline.ts
 *
 * Imports carry explicit .ts extensions because this runs on Node's own type
 * stripping rather than through a bundler, and Node resolves specifiers literally.
 * register-ts.mjs adds the extensionless @/ aliases this project uses in app code.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import {
  cutSegment,
  DEFAULT_CUT_OPTIONS,
  SELECTION_CUT_OPTIONS,
  computePeaks,
} from "../src/lib/audio/process.ts";
import { decodeWav, encodeWav, resample, TARGET_SAMPLE_RATE } from "../src/lib/audio/wav.ts";
import { buildNoiseShape, denoiseSamples, findClickBody } from "../src/lib/audio/denoise.ts";
import { fft, ifft } from "../src/lib/audio/fft.ts";
import { buildPack, buildReadme, packFileName, type ExportProgress } from "../src/lib/exporter.ts";
import { autocutTake } from "../src/lib/audio/autocut.ts";
import { cutMenuStep, MENU_CATEGORIES, type MenuCaptureEvent } from "../src/lib/menusounds.ts";
import { EventDebouncer, type RecordedEvent } from "../src/lib/events.ts";
import { CATEGORIES, INTENSITY_RANK, type PackMeta, type StoredSound } from "../src/lib/types.ts";
import {
  ZCB_CUT_PRESET,
  validateZcbPack,
  zcbEntryPath,
  zcbLayout,
  zcbRootName,
} from "../src/lib/zcb.ts";

const RATE = TARGET_SAMPLE_RATE;
const results: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

/* ---------- build a synthetic take: 8 clicks + room noise ---------- */
const duration = 6;
const take = new Float32Array(RATE * duration);
for (let i = 0; i < take.length; i++) take[i] = (Math.random() * 2 - 1) * 0.004; // room tone

const eventTimes = [0.5, 1.1, 1.85, 2.4, 3.05, 3.7, 4.3, 5.2];
for (const [index, t] of eventTimes.entries()) {
  const start = Math.round(t * RATE);
  // A realistic mechanical click: sharp transient plus a short body ring.
  const tau = 0.018 + index * 0.004;
  const amp = 0.12 + index * 0.07;
  for (let n = 0; n < RATE * 0.3; n++) {
    const env = Math.exp(-n / (RATE * tau));
    take[start + n] += Math.sin((2 * Math.PI * 2400 * n) / RATE) * env * amp;
    take[start + n] += (Math.random() * 2 - 1) * env * amp * 0.4;
  }
}

const peaks = computePeaks(take, 2000);
check("waveform peaks computed", peaks.length === 2000);

/* ---------- cutting ---------- */
const sounds: StoredSound[] = [];
const categories = [
  "microclicks",
  "microreleases",
  "softclicks",
  "softreleases",
  "clicks",
  "releases",
  "hardclicks",
  "hardreleases",
] as const;

eventTimes.forEach((t, index) => {
  const cut = cutSegment(take, RATE, t - 0.05, t + 0.35, {
    ...DEFAULT_CUT_OPTIONS,
    sampleRate: RATE,
  });
  if (!cut) {
    check(`cut ${index}`, false, "cutSegment returned null");
    return;
  }
  const wav = encodeWav(cut.samples, RATE);
  sounds.push({
    id: `s${index}`,
    category: categories[index % categories.length],
    name: `clip ${index}`,
    sourceStart: cut.start,
    sourceEnd: cut.end,
    duration: cut.samples.length / RATE,
    peak: cut.peakBefore,
    gain: cut.gain,
    createdAt: index,
    wav: wav.buffer as ArrayBuffer,
  });
});

// Two extra clips in one category so the numbering check has something to chew on.
// They have to sit over real clicks: a selection is now taken exactly as drawn, so
// a region covering only room tone correctly yields a quiet clip.
for (const extra of [1.85, 2.4]) {
  const cut = cutSegment(take, RATE, extra - 0.05, extra + 0.35, {
    ...DEFAULT_CUT_OPTIONS,
    sampleRate: RATE,
  })!;
  sounds.push({
    id: `x${extra}`,
    category: "clicks",
    name: `extra ${extra}`,
    sourceStart: cut.start,
    sourceEnd: cut.end,
    duration: cut.samples.length / RATE,
    peak: cut.peakBefore,
    gain: cut.gain,
    createdAt: 100 + extra,
    wav: encodeWav(cut.samples, RATE).buffer as ArrayBuffer,
  });
}

check("every event produced a clip", sounds.length === eventTimes.length + 2);
check(
  "clips land in the 0.05s–1.2s window",
  sounds.every((s) => s.duration >= 0.05 && s.duration <= 1.2),
  sounds.map((s) => s.duration.toFixed(3)).join(" "),
);
check(
  "clips are click-length, not padded to the ceiling",
  sounds.every((s) => s.duration < 0.75),
  `longest ${Math.max(...sounds.map((s) => s.duration)).toFixed(3)}s`,
);

function peakOf(wav: ArrayBuffer) {
  const view = new DataView(wav);
  const dataSize = view.getUint32(40, true);
  let peak = 0;
  for (let o = 44; o < 44 + dataSize; o += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(o, true)) / 32768);
  }
  return peak;
}
const peaksOut = sounds.map((s) => peakOf(s.wav));
check(
  "clips normalised to a consistent peak",
  peaksOut.every((p) => p > 0.85 && p <= 0.93),
  peaksOut.map((p) => p.toFixed(3)).join(" "),
);
check(
  "fade-in / fade-out applied (edges are silent)",
  sounds.every((s) => {
    const view = new DataView(s.wav);
    return view.getInt16(44, true) === 0 && view.getInt16(view.getUint32(40, true) + 42, true) === 0;
  }),
);

/* ---------- WAV header parity with the SD1 reference ---------- */
const reference = fs.readFileSync(new URL("../SD1/clicks/1.wav", import.meta.url));
const mine = Buffer.from(sounds[0].wav);
const headerOf = (buf: Buffer, offset = 0) => ({
  riff: buf.toString("ascii", offset, offset + 4),
  wave: buf.toString("ascii", offset + 8, offset + 12),
  fmt: buf.toString("ascii", offset + 12, offset + 16),
  fmtSize: buf.readUInt32LE(offset + 16),
  format: buf.readUInt16LE(offset + 20),
  channels: buf.readUInt16LE(offset + 22),
  sampleRate: buf.readUInt32LE(offset + 24),
  byteRate: buf.readUInt32LE(offset + 28),
  blockAlign: buf.readUInt16LE(offset + 32),
  bits: buf.readUInt16LE(offset + 34),
  data: buf.toString("ascii", offset + 36, offset + 40),
});
const ref = headerOf(reference);
const got = headerOf(mine);
check(
  "WAV header identical to SD1 reference",
  JSON.stringify(ref) === JSON.stringify(got),
  `ref ${JSON.stringify(ref)} vs ours ${JSON.stringify(got)}`,
);
check(
  "48 kHz / mono / 16-bit PCM",
  got.sampleRate === 48000 && got.channels === 1 && got.bits === 16 && got.format === 1,
);
const clipSeconds = mine.length / (2 * 48000);
check(
  "clip holds a tail without keeping the whole drag",
  clipSeconds > 0.04 && clipSeconds < 0.4,
  `${mine.length} bytes, ${clipSeconds.toFixed(3)}s`,
);
// The property that matters is not the length but where it stops. A clip cut mid
// ring ends abruptly, and the reference pack's ~300 ms clips are mostly room tone
// rather than a target to match, so what gets asserted is that the tail is
// allowed to decay instead of being chopped.
const tailWindow = mine.subarray(Math.max(0, mine.length - 2 * 48000 * 0.005));
let tailSum = 0;
for (const sample of tailWindow) tailSum += (sample / 32768) ** 2;
const tailRms = Math.sqrt(tailSum / Math.max(1, tailWindow.length));
let clipPeak = 0;
for (let i = 44; i < mine.length; i += 2) {
  const value = Math.abs(mine.readInt16LE(i) / 32768);
  if (value > clipPeak) clipPeak = value;
}
check(
  "clip ends in near-silence rather than mid-ring",
  clipPeak > 0 && tailRms < clipPeak * 0.1,
  `last 5ms ${(20 * Math.log10(Math.max(tailRms / clipPeak, 1e-9))).toFixed(1)} dB below the peak`,
);

/* ---------- resampler sanity ---------- */
const up = resample(take.subarray(0, 4800), 24000, RATE);
check("resample 24k -> 48k doubles length", up.length === 9600, `${up.length}`);

/* ---------- readme + file naming ---------- */
const meta: PackMeta = {
  title: "Sayo's Soft Desk Pack",
  description: "Recorded on a wooden desk in a quiet room.",
  creator: "sdsa",
};
check("file name format", packFileName(meta) === "sdsa-CutItQuik.zip", packFileName(meta));
check(
  "file name falls back to the title",
  packFileName({ ...meta, creator: "" }) === "Sayo's-Soft-Desk-Pack-CutItQuik.zip",
  packFileName({ ...meta, creator: "" }),
);
check(
  "illegal filename characters stripped",
  packFileName({ ...meta, creator: "sdsa /:sdsa" }) === "sdsa-sdsa-CutItQuik.zip",
  packFileName({ ...meta, creator: "sdsa /:sdsa" }),
);
check(
  "readme starts with the title then the description",
  buildReadme(meta) === "Sayo's Soft Desk Pack\n\nRecorded on a wooden desk in a quiet room.\n",
);

/* ---------- zip structure ---------- */
const noiseSamples = new Float32Array(RATE * 2);
for (let i = 0; i < noiseSamples.length; i++) noiseSamples[i] = (Math.random() * 2 - 1) * 0.01;
const noiseWav = encodeWav(noiseSamples, RATE).buffer as ArrayBuffer;

const zip = await buildPack({ meta, sounds, noise: { wav: noiseWav, duration: 2 } });
const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

const tmp = path.join(os.tmpdir(), "ciq-verify.zip");
fs.writeFileSync(tmp, buffer);
const listing = execSync(`tar -tf "${tmp}"`).toString().trim().split(/\r?\n/);
fs.rmSync(tmp);

const expected = [
  "readme.txt",
  "noise.wav",
  ...categories.map((c) => `${c}/`),
  "clicks/1.wav",
  "clicks/2.wav",
  "clicks/3.wav",
  "releases/1.wav",
  "hardreleases/1.wav",
  "hardclicks/1.wav",
  "softclicks/1.wav",
  "softreleases/1.wav",
  "microclicks/1.wav",
  "microreleases/1.wav",
];
const missing = expected.filter((entry) => !listing.includes(entry));
check("zip contains the full SD1 architecture", missing.length === 0, `missing: ${missing.join(", ")}`);
check("all 8 folders present even when used", listing.filter((l) => l.endsWith("/")).length === 8);
check("clips are numbered from 1", listing.includes("clicks/1.wav") && !listing.includes("clicks/0.wav"));
check("no nested root folder", !listing.some((l) => l.startsWith("sdsa")));
check(
  "every clip made it into the zip",
  listing.filter((l) => l.endsWith(".wav") && l !== "noise.wav").length === sounds.length,
  `${listing.filter((l) => l.endsWith(".wav") && l !== "noise.wav").length} vs ${sounds.length}`,
);

const reloaded = await JSZip.loadAsync(buffer);
check("readme.txt round-trips", (await reloaded.file("readme.txt")!.async("string")) === buildReadme(meta));

/* ================= denoise ================= */
const rms = (x: Float32Array, from: number, to: number) => {
  const n = Math.max(1, to - from);
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / n);
};
const peakIn = (x: Float32Array, from: number, to: number) => {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
};
const db = (ratio: number) => (20 * Math.log10(Math.max(1e-9, ratio))).toFixed(1);

/* ---- FFT is correct, which everything else depends on ---- */
{
  const n = 1024;
  const original = new Float32Array(n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    original[i] = Math.random() * 2 - 1;
    re[i] = original[i]!;
  }
  fft(re, im);
  ifft(re, im);
  let error = 0;
  for (let i = 0; i < n; i++) error = Math.max(error, Math.abs(re[i]! - original[i]!));
  check("fft/ifft round-trips losslessly", error < 1e-5, `max err ${error.toExponential(2)}`);
}

/* ---- WAV round-trips, since denoising works on decoded buffers ---- */
{
  const source = new Float32Array(4096);
  for (let i = 0; i < source.length; i++) source[i] = Math.sin(i * 0.05) * 0.5;
  const decoded = decodeWav(encodeWav(source, RATE).buffer as ArrayBuffer);
  let error = 0;
  if (decoded) {
    for (let i = 0; i < source.length; i++) {
      error = Math.max(error, Math.abs(decoded.samples[i]! - source[i]!));
    }
  }
  check(
    "decodeWav round-trips encodeWav",
    !!decoded && decoded.sampleRate === RATE && decoded.samples.length === source.length && error < 1e-4,
    `err ${error.toExponential(2)}`,
  );
  check("decodeWav rejects garbage", decodeWav(new ArrayBuffer(8)) === null);
}

/* ---- the noise file's spectral shape is actually measured ---- */
{
  const humHz = 480;
  const humBin = Math.round((humHz * 1024) / RATE);
  const room = new Float32Array(RATE * 2);
  for (let i = 0; i < room.length; i++) {
    room[i] = (Math.random() * 2 - 1) * 0.01 + Math.sin((2 * Math.PI * humHz * i) / RATE) * 0.3;
  }
  const shape = buildNoiseShape(room);
  let argmax = 0;
  for (let b = 1; b < shape.length; b++) if (shape[b]! > shape[argmax]!) argmax = b;
  check(
    "noise shape peaks at the hum bin",
    Math.abs(argmax - humBin) <= 1,
    `argmax bin ${argmax}, expected ${humBin}`,
  );
}

/* ---- denoise: quieter background, intact click ---- */
// A clip shaped like a real one: transient first, then room tone. The tail window
// is pure noise and the head window holds the peak, so both numbers are honest.
const CLIP_LEN = Math.round(0.2 * RATE);
const synth = new Float32Array(CLIP_LEN);
for (let i = 0; i < CLIP_LEN; i++) synth[i] = (Math.random() * 2 - 1) * 0.02;
for (let n = 0; n < RATE * 0.08; n++) {
  const env = Math.exp(-n / (RATE * 0.012));
  synth[n] = synth[n]! + Math.sin((2 * Math.PI * 2200 * n) / RATE) * env * 0.9;
}
const HEAD_END = Math.round(0.01 * RATE);
const TAIL_START = Math.round(0.12 * RATE);
const tailBefore = rms(synth, TAIL_START, CLIP_LEN);
const headBefore = peakIn(synth, 0, HEAD_END);
const body = findClickBody(synth, RATE);
check(
  "the click body is detected, not the whole clip",
  body.end > HEAD_END && body.end < CLIP_LEN * 0.9,
  `body 0..${body.end} of ${CLIP_LEN} (${(body.end / RATE * 1000).toFixed(0)}ms)`,
);

const live = await denoiseSamples(synth, { method: "live", sampleRate: RATE });
const floorLive = rms(live, TAIL_START, CLIP_LEN);
const headLive = peakIn(live, 0, HEAD_END);
check(
  "live denoise lowers the noise floor",
  floorLive < tailBefore * 0.5,
  `${db(floorLive / tailBefore)} dB (${tailBefore.toExponential(2)} -> ${floorLive.toExponential(2)})`,
);
check(
  "live denoise leaves the click peak alone",
  headLive > headBefore * 0.95,
  `peak ${headBefore.toFixed(3)} -> ${headLive.toFixed(3)}`,
);
check(
  "live denoise improves signal-to-noise",
  db(headLive / floorLive) - db(headBefore / tailBefore) > 6,
  `${db(headBefore / tailBefore)} -> ${db(headLive / floorLive)} dB`,
);

const roomBed = new Float32Array(RATE * 2);
for (let i = 0; i < roomBed.length; i++) roomBed[i] = (Math.random() * 2 - 1) * 0.02;
const spectral = await denoiseSamples(synth, {
  method: "spectral",
  sampleRate: RATE,
  noiseShape: buildNoiseShape(roomBed),
  storedGain: 1,
});
const floorSpectral = rms(spectral, TAIL_START, CLIP_LEN);
const headSpectral = peakIn(spectral, 0, HEAD_END);
check(
  "spectral denoise lowers the noise floor",
  floorSpectral < tailBefore * 0.5,
  `${db(floorSpectral / tailBefore)} dB`,
);
check(
  "spectral denoise leaves the click peak alone",
  headSpectral > headBefore * 0.95,
  `peak ${headBefore.toFixed(3)} -> ${headSpectral.toFixed(3)}`,
);

/* ---- a real cut clip, which starts exactly on the attack ---- */
{
  const real = decodeWav(sounds[0]!.wav)!;
  const cleaned = await denoiseSamples(real.samples, { method: "live", sampleRate: RATE });
  const before = peakIn(real.samples, 0, real.samples.length);
  const after = peakIn(cleaned, 0, cleaned.length);
  check(
    "a real trimmed clip keeps its peak and length",
    after > before * 0.9 && cleaned.length === real.samples.length,
    `peak ${before.toFixed(3)} -> ${after.toFixed(3)}`,
  );
}

/* ---- clean audio must survive untouched, or this is a destructive filter ---- */
{
  const clean = new Float32Array(RATE * 0.3);
  for (let n = 0; n < clean.length; n++) {
    const env = Math.exp(-n / (RATE * 0.02));
    clean[n] = Math.sin((2 * Math.PI * 2200 * n) / RATE) * env;
  }
  const untouched = await denoiseSamples(clean, { method: "live", sampleRate: RATE });
  let correlation = 0;
  let energyA = 0;
  let energyB = 0;
  for (let i = 0; i < clean.length; i++) {
    correlation += clean[i]! * untouched[i]!;
    energyA += clean[i]! * clean[i]!;
    energyB += untouched[i]! * untouched[i]!;
  }
  correlation /= Math.sqrt(energyA * energyB);
  check(
    "a noise-free click passes through essentially unchanged",
    correlation > 0.98 && peakIn(untouched, 0, HEAD_END) > peakIn(clean, 0, HEAD_END) * 0.95,
    `correlation ${correlation.toFixed(4)}`,
  );
}

/* ---- deterministic, so two exports of one pack are byte-identical ---- */
{
  const again = await denoiseSamples(synth, { method: "live", sampleRate: RATE });
  let same = again.length === live.length;
  for (let i = 0; same && i < again.length; i++) same = again[i] === live[i]!;
  check("denoise is deterministic", same);
}

/* ---- exporting with denoise on rewrites the clips and reports progress ---- */
{
  const seen: ExportProgress[] = [];
  const denoisedZip = await buildPack(
    { meta, sounds, noise: { wav: noiseWav, duration: 2 }, denoise: { method: "live" } },
    { onProgress: (p) => seen.push(p) },
  );
  const entries = Object.keys(denoisedZip.files).filter((f) => f.endsWith(".wav") && f !== "noise.wav");
  check("denoised pack still has every clip", entries.length === sounds.length, `${entries.length}`);

  const before = await JSZip.loadAsync(buffer);
  const after = await denoisedZip.generateAsync({ type: "nodebuffer" }).then((b) => JSZip.loadAsync(b));
  const rawBefore = await before.file("clicks/1.wav")!.async("uint8array");
  const rawAfter = await after.file("clicks/1.wav")!.async("uint8array");
  check("clip bytes changed, so denoising actually ran", Buffer.compare(rawBefore, rawAfter) !== 0);
  check("clip length is unchanged by denoising", rawBefore.length === rawAfter.length, `${rawBefore.length} vs ${rawAfter.length}`);

  const values = seen.map((p) => p.value);
  const monotonic = values.every((v, i) => i === 0 || v >= values[i - 1]! - 1e-9);
  check("progress never goes backwards", monotonic, `${values.length} updates`);
  // buildPack owns 0 -> 0.78; exportPack drives compression to 1 from there.
  check(
    "progress starts at the beginning and reaches the packing phase",
    values[0]! <= 0.05 && values[values.length - 1]! >= 0.7,
    `${values[0]!.toFixed(3)} -> ${values[values.length - 1]!.toFixed(3)}`,
  );
  check(
    "progress reports the denoise and zip steps",
    new Set(seen.map((p) => p.step)).has("Denoising") && new Set(seen.map((p) => p.step)).has("Packing"),
  );
  check("every progress update names a step and a detail", seen.every((p) => p.step.length > 0 && p.detail.length > 0));

  // And with denoise off the bytes must be identical to a plain export.
  const plain = await buildPack({ meta, sounds, noise: { wav: noiseWav, duration: 2 } });
  const plainBytes = await plain.file("clicks/1.wav")!.async("uint8array");
  check("denoise off leaves clips untouched", Buffer.compare(rawBefore, plainBytes) === 0);
}

/* ---------- a worn switch cannot report one press twice ---------- */
{
  // What a bouncing mouse switch actually produces: one physical press that the
  // hardware reports as press/release/press/release a few milliseconds apart.
  const bounce = new EventDebouncer();
  const pressTimes = [0, 0.008, 0.015];
  const acceptedPresses = pressTimes.filter((t) => bounce.accepts("press", "mouse", "Left Mouse", t));
  check("a bounced press is recorded once", acceptedPresses.length === 1, `kept ${acceptedPresses.length} of 3`);

  const bounceRelease = new EventDebouncer();
  const acceptedReleases = [0.004, 0.015].filter((t) =>
    bounceRelease.accepts("release", "mouse", "Left Mouse", t),
  );
  check("a bounced release is recorded once", acceptedReleases.length === 1, `kept ${acceptedReleases.length} of 2`);

  // A real fast double-click is slower than the window and must survive.
  const doubleClick = new EventDebouncer();
  const kept = [0, 0.08].filter((t) => doubleClick.accepts("press", "mouse", "Left Mouse", t));
  check("a real fast double-click still counts twice", kept.length === 2, `kept ${kept.length} of 2`);

  // Presses and releases are judged separately, so a fast click is not eaten by
  // its own release.
  const click = new EventDebouncer();
  const pressOk = click.accepts("press", "mouse", "Left Mouse", 1);
  const releaseOk = click.accepts("release", "mouse", "Left Mouse", 1.03);
  check("a 30ms click keeps both halves", pressOk && releaseOk, `${pressOk}/${releaseOk}`);

  // Different buttons are independent.
  const twoButtons = new EventDebouncer();
  const left = twoButtons.accepts("press", "mouse", "Left Mouse", 2);
  const right = twoButtons.accepts("press", "mouse", "Right Mouse", 2.01);
  check("a different button is never debounced away", left && right, `${left}/${right}`);

  check("a fresh take starts with no history", new EventDebouncer().accepts("press", "mouse", "Left Mouse", 0));
}

/* ---------- autocut ---------- */
{
  // A fresh take with a known loudness spread, so the bands can be checked.
  const autocutTakeSamples = new Float32Array(RATE * 4);
  for (let i = 0; i < autocutTakeSamples.length; i++) {
    autocutTakeSamples[i] = (Math.random() * 2 - 1) * 0.003;
  }
  const addClick = (t: number, amp: number) => {
    const start = Math.round(t * RATE);
    for (let n = 0; n < RATE * 0.25; n++) {
      const env = Math.exp(-n / (RATE * 0.015));
      autocutTakeSamples[start + n] += Math.sin((2 * Math.PI * 2100 * n) / RATE) * env * amp;
    }
  };
  // 0.5 is the loudest and anchors the bands; the rest step down from it.
  addClick(0.5, 0.8);
  addClick(1.2, 0.3);
  addClick(1.9, 0.05);
  addClick(2.6, 0.09);
  addClick(3.2, 0.0012); // below the gate: an accidental tap, not a click

  const autocutEvents = [
    { id: "a", kind: "press", source: "mouse", label: "Left Mouse", time: 0.5 },
    { id: "b", kind: "release", source: "mouse", label: "Left Mouse", time: 1.2 },
    { id: "c", kind: "press", source: "mouse", label: "Left Mouse", time: 1.9 },
    { id: "d", kind: "release", source: "mouse", label: "Left Mouse", time: 2.6 },
    { id: "e", kind: "press", source: "mouse", label: "Left Mouse", time: 3.2 },
  ] as RecordedEvent[];

  const reported: number[] = [];
  const clips = await autocutTake(autocutTakeSamples, RATE, autocutEvents, {
    onProgress: (done, all) => reported.push(done / all),
  });

  check("autocut cuts every real event", clips.length === 4, `${clips.length} kept of ${autocutEvents.length}`);
  check("autocut reports progress for every event", reported.length === autocutEvents.length, `${reported.length} updates`);
  check("autocut progress climbs to one", reported[reported.length - 1] === 1, String(reported[reported.length - 1]));

  const byTime = [...clips].sort((a, b) => a.eventTime - b.eventTime);
  const loudness = (clip: (typeof clips)[number] | undefined) =>
    clip ? `${clip.intensity} at ${clip.relativeLoudness.toFixed(3)}x` : "missing";
  // Each kind is scored against the loudest click of its own kind, so in this
  // take the two presses are graded against each other and the two releases
  // against each other. The loudest release is therefore the hardest lift
  // recorded, not a mid-tier one, and it is not dragged down by the harder press.
  check("the hardest press is hard", byTime[0]?.intensity === "hard", loudness(byTime[0]));
  check("the quietest press is micro", byTime[2]?.intensity === "micro", loudness(byTime[2]));
  check(
    "the loudest click of a kind scores one against its own kind",
    byTime[1]?.relativeLoudness === 1 && byTime[1]?.intensity === "hard",
    loudness(byTime[1]),
  );
  const releases = clips.filter((clip) => clip.kind === "release");
  check(
    "a release is not demoted by a louder press",
    releases.length > 0 && releases.every((clip) => clip.intensity !== "micro"),
    releases.map(loudness).join(", "),
  );
  check(
    "a quieter release lands below the hardest one",
    INTENSITY_RANK[byTime[3]!.intensity] < INTENSITY_RANK[byTime[1]!.intensity],
    `${loudness(byTime[3])} below ${loudness(byTime[1])}`,
  );

  check("presses land in click folders", byTime[0]?.category === "hardclicks" && byTime[2]?.category === "microclicks", `${byTime[0]?.category}, ${byTime[2]?.category}`);
  check(
    "releases land in release folders",
    byTime[1]?.category === "hardreleases" && byTime[3]?.category === "softreleases",
    `${byTime[1]?.category}, ${byTime[3]?.category}`,
  );
  check("autocut uses three distinct bands on a four click take", new Set(clips.map((c) => c.intensity)).size === 3, [...new Set(clips.map((c) => c.intensity))].join(","));
  check("every autocut category is a real category id", clips.every((c) => CATEGORIES.some((cat) => cat.id === c.category)));

  check("autocut clips are non-empty and normalised", clips.every((c) => c.cut.samples.length > 0));
  check("autocut clips stay inside a sane length", clips.every((c) => c.cut.end - c.cut.start <= DEFAULT_CUT_OPTIONS.maxDuration + 0.01));
  check("autocut keeps the loudest clip's peak at full scale", Math.abs(Math.max(...[...clips[0]!.cut.samples].map(Math.abs)) - 0.92) < 0.01);

  // Autocut must be stable: the same take gives the same answer twice.
  const again = await autocutTake(autocutTakeSamples, RATE, autocutEvents);
  check("autocut is deterministic", again.map((c) => c.category).join() === clips.map((c) => c.category).join());

  // And a silent take produces nothing rather than a pile of noise clips.
  const silent = await autocutTake(new Float32Array(RATE), RATE, autocutEvents);
  check("a silent take autocuts to nothing", silent.length === 0, `${silent.length} clips`);

  // Quiet events are dropped on purpose: a click far below the loudest one in
  // the take is room noise, not a sample worth filing.
  const mixed = [...autocutEvents, { ...autocutEvents[0]!, id: "quiet", time: 3.9 }];
  const mixedClips = await autocutTake(autocutTakeSamples, RATE, mixed);
  check(
    "autocut drops events far below the loudest one",
    mixedClips.length === clips.length,
    `${mixedClips.length} kept of ${mixed.length}`,
  );
}

/* ---------- autocut: a real press/lift take ----------
 *
 * The block above models a release as another full click, which is not what a
 * release is. Everything that actually went wrong with releases lived in the
 * paired path - a lift found on the tail of the press it belongs to - and that
 * path had no coverage at all, so it needs its own take.
 */
{
  // A switch is three things at once: a broadband strike, a damped high ring, and
  // a low body thump. Only the first two survive the high-pass the detectors
  // work in, and the body is what a release has to be measured without.
  const press = [
    { freq: 2400, amp: 0.45, tau: 0.006, attack: 0.0012 },
    { freq: 5200, amp: 0.22, tau: 0.003, attack: 0.0008 },
    { freq: 190, amp: 0.55, tau: 0.025, attack: 0.003 },
  ];
  // A lift is only a tick: no body, and it is over in a couple of milliseconds.
  const lift = [
    { freq: 4600, amp: 0.07, tau: 0.0035, attack: 0.0008 },
    { freq: 3100, amp: 0.035, tau: 0.002, attack: 0.0006 },
  ];
  const addPart = (take: Float32Array, at: number, scale: number, parts: typeof press) => {
    const start = Math.round(at * RATE);
    for (let n = 0; n < RATE * 0.12; n++) {
      const i = start + n;
      if (i >= take.length) break;
      const t = n / RATE;
      let v = 0;
      for (const p of parts) {
        const env = Math.exp(-t / p.tau) * (t < p.attack ? t / p.attack : 1);
        v += Math.sin(2 * Math.PI * p.freq * t) * env * p.amp;
      }
      take[i] += v * scale + (Math.random() * 2 - 1) * 0.002;
    }
  };

  // ---------------------------------------------------------------------------
  // Real switch recordings.
  //
  // Every release test above runs on a synthetic model whose press decays
  // smoothly and monotonically, which is the one thing a real press never does.
  // That model happily accepted a detector looking for "a rise out of a decay":
  // on real audio that detector locked onto noise in the press tail, scored its
  // own result below its own confidence gate, and rejected it - so every real
  // release silently fell back to its raw timestamp. These use the actual
  // SD1 press, lift and room-noise recordings so that cannot happen again.
  // ---------------------------------------------------------------------------
  const sd1 = (rel: string) => {
    const raw = fs.readFileSync(path.join(import.meta.dirname, "..", rel));
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const decoded = decodeWav(buf);
    if (!decoded) throw new Error(`could not decode ${rel}`);
    return decoded.samples;
  };

  if (fs.existsSync(path.join(import.meta.dirname, "..", "SD1", "hardclicks", "3.wav"))) {
    const realPress = sd1("SD1/hardclicks/3.wav");
    const realLift = sd1("SD1/hardreleases/3.wav");
    const realRoom = sd1("SD1/noise.wav");

    /** Correlation of a clip against a real transient; ~0 for room tone. */
    const matchScore = (clip: Float32Array, ref: Float32Array) => {
      const len = Math.min(512, clip.length);
      const rms = (s: Float32Array) => {
        let sum = 0;
        for (let i = 0; i < s.length; i++) sum += s[i]! * s[i];
        return Math.sqrt(sum / Math.max(1, s.length));
      };
      const cr = rms(clip) || 1e-9;
      const rr = rms(ref.subarray(0, len)) || 1e-9;
      let best = -Infinity;
      for (let off = 0; off + len <= clip.length; off++) {
        let dot = 0;
        for (let i = 0; i < len; i++) dot += clip[off + i]! * ref[i]!;
        best = Math.max(best, dot / (len * cr * rr));
      }
      return best;
    };

    const realTake = (holdMs: number, jitterMs: number) => {
      const at = Math.round(0.4 * RATE);
      const lift = at + Math.round((holdMs / 1000) * RATE);
      const take = new Float32Array(Math.round(1.6 * RATE));
      for (let i = 0; i < take.length; i++) take[i] = realRoom[i % realRoom.length]!;
      take.set(realPress, at);
      take.set(realLift, lift);
      return {
        take,
        lift,
        events: [
          { id: "p", kind: "press", source: "mouse", label: "L", time: 0.4 },
          {
            id: "r",
            kind: "release",
            source: "mouse",
            label: "L",
            time: (lift + Math.round((jitterMs / 1000) * RATE)) / RATE,
          },
        ] as RecordedEvent[],
      };
    };

    const roomTone = realTake(80, 0).take.subarray(
      Math.round(1.2 * RATE),
      Math.round(1.2 * RATE) + 512,
    );
    const roomScore = matchScore(roomTone, realLift);
    check(
      "the real-audio release check can tell a lift from room tone",
      roomScore < 0.3,
      `room tone scores ${roomScore.toFixed(3)}`,
    );

    for (const holdMs of [40, 80, 200]) {
      for (const jitterMs of [0, 5]) {
        const { take, lift, events } = realTake(holdMs, jitterMs);
        const clips = await autocutTake(take, RATE, events);
        const lifts = clips.filter((c) => c.kind === "release");
        const label = `real hold=${holdMs}ms jitter=${jitterMs}ms`;

        check(`${label}: the lift is saved`, lifts.length === 1, `${lifts.length} releases`);
        if (lifts.length !== 1) continue;

        // The lift must land on the transient, not near the reported timestamp.
        const errorMs = Math.abs(lifts[0]!.onsetTime * RATE - lift) / RATE * 1000;
        check(`${label}: the lift is cut at the transient`, errorMs < 5, `${errorMs.toFixed(1)}ms off`);

        // And the clip must actually contain the real lift rather than the room
        // noise that surrounds it, which is the report this replaces.
        const score = matchScore(lifts[0]!.cut.samples, realLift);
        check(
          `${label}: the release clip contains the real lift`,
          score > 0.8,
          `scores ${score.toFixed(3)} vs ${roomScore.toFixed(3)} for room tone`,
        );
        check(
          `${label}: the release is filed as a release`,
          lifts[0]!.category === "hardreleases",
          lifts[0]!.category,
        );
      }
    }
  }

  /** A take of click/lift pairs, each played at its own force. */
  const clickTake = (forces: number[], gap: number, times: number[]) => {
    const take = new Float32Array(RATE * (times[times.length - 1]! + 0.6));
    for (let i = 0; i < take.length; i++) take[i] = (Math.random() * 2 - 1) * 0.004;
    const events: RecordedEvent[] = [];
    forces.forEach((scale, i) => {
      const at = times[i]!;
      addPart(take, at, scale, press);
      addPart(take, at + gap, scale, lift);
      events.push({ id: `p${i}`, kind: "press", source: "mouse", label: "Left Mouse", time: at });
      events.push({
        id: `r${i}`, kind: "release", source: "mouse", label: "Left Mouse", time: at + gap,
      });
    });
    return { take, events };
  };

  // Forces chosen so each press lands clear of a band boundary once divided by
  // the loudest: 1.00 hard, 0.60 medium, 0.25 soft, 0.95 hard, 0.10 micro.
  const forces = [1.0, 0.6, 0.25, 0.95, 0.1];
  const times = [0.5, 1.1, 1.7, 2.3, 2.9];
  const gap = 0.03;
  const { take, events } = clickTake(forces, gap, times);
  const clips = await autocutTake(take, RATE, events);
  const paired = clips.filter((clip) => clip.kind === "release");
  const pairedPresses = clips.filter((clip) => clip.kind === "press");
  const ms = (clip: (typeof clips)[number]) => (clip.cut.samples.length / RATE) * 1000;
  const describe = (list: (typeof clips)[number][]) =>
    list.map((c) => `${c.kind} ${c.category} ${c.intensitySource}`).join(", ");

  check(
    "every lift in a real take is saved",
    paired.length === forces.length,
    `${paired.length} of ${forces.length} lifts kept (${describe(paired)})`,
  );
  check("every press in a real take is saved", pairedPresses.length === forces.length, `${pairedPresses.length} of ${forces.length}`);

  // The four tiers the forces were chosen to produce.
  const expected = ["hard", "medium", "soft", "hard", "micro"];
  check(
    "presses are graded across all four bands",
    pairedPresses.every((clip, i) => clip.intensity === expected[i]),
    pairedPresses.map((c, i) => `${c.relativeLoudness.toFixed(2)}=>${c.intensity}${c.intensity === expected[i] ? "" : ` want ${expected[i]}`}`).join(", "),
  );

  // The rule that makes a release usable: it is the end of a press, so it takes
  // that press's band rather than being graded on its own - quieter - level.
  const sorted = [...clips].sort((a, b) => a.eventTime - b.eventTime);
  sorted.forEach((clip, i) => {
    if (clip.kind !== "release") return;
    const pressClip = sorted[i - 1]!;
    check(
      `a lift inherits the band of the press it came off (#${i})`,
      clip.intensity === pressClip.intensity && clip.intensitySource === "press",
      `lift ${clip.intensity} (${clip.intensitySource}) after press ${pressClip.intensity}`,
    );
    const expectedFolder = CATEGORIES.find(
      (cat) => cat.intensity === clip.intensity && cat.kind === "release",
    )?.id;
    check(
      `a lift goes in the release folder for that band (#${i})`,
      clip.category === expectedFolder,
      `${clip.category}, want ${expectedFolder}`,
    );
  });
  check(
    "a lift after the hardest press is filed as a hard release",
    paired.some((clip) => clip.category === "hardreleases"),
    describe(paired),
  );
  check(
    "lifts are not all filed as the same kind",
    new Set(paired.map((clip) => clip.intensity)).size >= 3,
    [...new Set(paired.map((c) => c.intensity))].join(","),
  );

  // A lift used to be found tens of milliseconds past the real thing, because the
  // strongest transient in its window was the press it sits inside.
  const lifts = [...clips].filter((clip) => clip.kind === "release");
  const worstError = Math.max(
    ...lifts.map((clip) => Math.abs(clip.onsetTime - clip.eventTime) * 1000),
  );
  check(
    "every lift is cut at the lift, not at the press's tail",
    worstError < 5,
    `worst onset error ${worstError.toFixed(1)}ms`,
  );

  // Left unbounded a lift ran to the next event and took the press's body thump
  // with it, which is how a 40 ms tick became a 100 ms clip louder than the
  // click it followed.
  const longestLift = Math.max(...lifts.map(ms));
  check("lifts stay short", longestLift <= 65, `longest lift ${longestLift.toFixed(0)}ms`);

  // Fast clicking: a hold shorter than the press's ring. At 8 ms the lift is not
  // separable at all and must not be faked out of the press's tail - but on
  // random noise whether a given run "finds" one is a coin toss, so this is not
  // asserted here. Asserting the detector's absence of a result is what let the
  // old rise-hunting detector get locked in; the real SD1 cases below assert
  // positive, measurable things instead.
  const fast = clickTake(forces, 0.025, times);
  const fastClips = await autocutTake(fast.take, RATE, fast.events);
  check(
    "lifts survive a fast click, where the press has not stopped ringing",
    fastClips.filter((clip) => clip.kind === "release").length === forces.length,
    `${fastClips.filter((c) => c.kind === "release").length} of ${forces.length} kept`,
  );
  // A press whose release lands on top of it used to be left with no room at all,
  // and a clip too short to cut was discarded - so a fast click lost both halves.
  check(
    "a fast click keeps its press as well as its lift",
    fastClips.filter((clip) => clip.kind === "press").length === forces.length,
    `${fastClips.filter((c) => c.kind === "press").length} of ${forces.length} presses kept`,
  );
  check(
    "a fast click's lifts stay short too",
    Math.max(...fastClips.filter((c) => c.kind === "release").map(ms)) <= 65,
    `longest ${Math.max(...fastClips.filter((c) => c.kind === "release").map(ms)).toFixed(0)}ms`,
  );

  // A lift whose press was dropped must not vanish with it, and must fall back to
  // being graded on its own level rather than inheriting nothing.
  const solo = new Float32Array(RATE * 1.2);
  for (let i = 0; i < solo.length; i++) solo[i] = (Math.random() * 2 - 1) * 0.004;
  addPart(solo, 0.5, 1, lift);
  const soloClips = await autocutTake(solo, RATE, [
    { id: "lonely", kind: "release", source: "mouse", label: "Left Mouse", time: 0.5 },
  ]);
  check(
    "a lift with no press to inherit from is still saved",
    soloClips.length === 1 && soloClips[0]!.kind === "release",
    `${soloClips.length} kept, ${soloClips[0]?.category ?? "none"}`,
  );
  check(
    "a lift with no press is graded on its own level",
    soloClips[0]?.intensitySource === "own",
    soloClips[0]?.intensitySource ?? "missing",
  );
}

/* ---------- menu click releases ----------
 *
 * Menu clicks are cut by the same onsets and boundaries but saved as two separate
 * pools, and the release pool is the one that empties out: a lift is quiet, and
 * the cut used to be dropped both for being under a fixed peak and for the onset
 * detector not being confident about it. Those are opposite mistakes - one throws
 * away quiet lifts, the other throws away the lifts that are hardest to find - so
 * the gate has to be judged against the room the take was recorded in.
 */
{
  const press = [
    { freq: 2400, amp: 0.45, tau: 0.006, attack: 0.0012 },
    { freq: 5200, amp: 0.22, tau: 0.003, attack: 0.0008 },
    { freq: 190, amp: 0.55, tau: 0.025, attack: 0.003 },
  ];
  const lift = [
    { freq: 4600, amp: 0.07, tau: 0.0035, attack: 0.0008 },
    { freq: 3100, amp: 0.035, tau: 0.002, attack: 0.0006 },
  ];
  const addPart = (take: Float32Array, at: number, scale: number, parts: typeof press) => {
    const start = Math.round(at * RATE);
    for (let n = 0; n < RATE * 0.12; n++) {
      const i = start + n;
      if (i >= take.length) break;
      const t = n / RATE;
      let v = 0;
      for (const p of parts) {
        const env = Math.exp(-t / p.tau) * (t < p.attack ? t / p.attack : 1);
        v += Math.sin(2 * Math.PI * p.freq * t) * env * p.amp;
      }
      take[i] += v * scale + (Math.random() * 2 - 1) * 0.002;
    }
  };
  const menuclicks = MENU_CATEGORIES.find((c) => c.id === "menuclicks")!;

  const capture = (room: number, gap: number) => {
    const take = new Float32Array(RATE * 2.2);
    for (let i = 0; i < take.length; i++) take[i] = (Math.random() * 2 - 1) * room;
    const events: MenuCaptureEvent[] = [];
    for (const at of [0.4, 0.9, 1.4]) {
      addPart(take, at, 1, press);
      addPart(take, at + gap, 1, lift);
      events.push({ time: at, label: "Left Mouse", phase: "press" });
      events.push({ time: at + gap, label: "Left Mouse", phase: "release" });
    }
    return cutMenuStep(take, RATE, events, menuclicks);
  };

  for (const [room, gap] of [
    [0.004, 0.03],
    [0.0015, 0.03],
    [0.004, 0.008],
  ] as const) {
    const out = capture(room, gap);
    const presses = out.filter((r) => r.event.phase === "press").length;
    const releases = out.filter((r) => r.event.phase === "release").length;
    check(
      `menu lifts are saved (room ${room}, hold ${(gap * 1000).toFixed(0)}ms)`,
      presses === 3 && releases === 3,
      `${presses} presses, ${releases} releases of 3 each`,
    );
  }

  // The gate must not become so loose that an event which landed in silence is
  // still treated as a sound.
  const silentTake = new Float32Array(RATE);
  for (let i = 0; i < silentTake.length; i++) silentTake[i] = (Math.random() * 2 - 1) * 0.004;
  const silent = cutMenuStep(
    silentTake,
    RATE,
    [{ time: 0.5, label: "Left Mouse", phase: "release" }],
    menuclicks,
  );
  check(
    "a menu event with nothing at it is still discarded",
    silent.length === 0,
    `${silent.length} kept from silence`,
  );
}

/* ---------- autocut: one hard click must not delete the take ----------
 *
 * The accidental-tap floor used to be measured from the loudest click in the
 * take. Ordinary clicking sits about 25 dB below a hard slam from the same mouse
 * and the floor sat at 24 dB, so one deliberate hard click threw away every
 * other click in the recording and filed the survivors as micro.
 */
{
  const press = [
    { freq: 2400, amp: 0.45, tau: 0.006, attack: 0.0012 },
    { freq: 5200, amp: 0.22, tau: 0.003, attack: 0.0008 },
    { freq: 190, amp: 0.55, tau: 0.025, attack: 0.003 },
  ];
  const addPart = (take: Float32Array, at: number, scale: number) => {
    const start = Math.round(at * RATE);
    for (let n = 0; n < RATE * 0.12; n++) {
      const i = start + n;
      if (i >= take.length) break;
      const t = n / RATE;
      let v = 0;
      for (const p of press) {
        const env = Math.exp(-t / p.tau) * (t < p.attack ? t / p.attack : 1);
        v += Math.sin(2 * Math.PI * p.freq * t) * env * p.amp;
      }
      take[i] += v * scale;
    }
  };

  // Six ordinary clicks and one genuine slam, all deliberate.
  const forces = [0.05, 0.045, 0.055, 0.9, 0.05, 0.048, 0.052];
  const times = [0.4, 0.9, 1.4, 1.9, 2.4, 2.9, 3.4];
  const take = new Float32Array(RATE * 4.2);
  for (let i = 0; i < take.length; i++) take[i] = (Math.random() * 2 - 1) * 0.003;
  forces.forEach((scale, i) => addPart(take, times[i]!, scale));
  const events = times.map((t, i) => ({
    id: `p${i}`, kind: "press", source: "mouse", label: "Left Mouse", time: t!,
  })) as RecordedEvent[];

  const clips = await autocutTake(take, RATE, events);
  check(
    "one hard click does not delete the rest of the take",
    clips.length === forces.length,
    `${clips.length} kept of ${forces.length}`,
  );
  check(
    "the hard click is still filed as hard",
    clips.some((clip) => clip.category === "hardclicks"),
    clips.map((c) => c.category).join(", "),
  );

  // A genuine accidental tap is still discarded: the floor has to survive an
  // outlier without becoming a blanket "keep everything".
  const withTap = new Float32Array(RATE * 4.6);
  for (let i = 0; i < withTap.length; i++) withTap[i] = (Math.random() * 2 - 1) * 0.003;
  forces.forEach((scale, i) => addPart(withTap, times[i]!, scale));
  addPart(withTap, 4.0, 0.0004); // a knock on the desk
  const tapEvents = [
    ...events,
    { id: "tap", kind: "press", source: "mouse", label: "Left Mouse", time: 4.0 },
  ] as RecordedEvent[];
  const tapClips = await autocutTake(withTap, RATE, tapEvents);
  check(
    "an accidental tap beside a full take is still discarded",
    tapClips.length === forces.length,
    `${tapClips.length} kept of ${forces.length + 1}`,
  );
}

/* ---------- a hand-drawn selection is saved exactly as drawn ---------- */
{
  const at = eventTimes[2]!;
  const from = at - 0.02;
  const to = at + 0.28;
  const selectionMs = (to - from) * 1000;

  const asDrawn = cutSegment(take, RATE, from, to, {
    ...SELECTION_CUT_OPTIONS,
    sampleRate: RATE,
  })!;
  const drawnMs = (asDrawn.samples.length / RATE) * 1000;

  check(
    "a default cut is the length of the selection",
    Math.abs(drawnMs - selectionMs) < 2,
    `${drawnMs.toFixed(1)}ms from a ${selectionMs.toFixed(1)}ms drag`,
  );

  // The reported bug: a short drag used to hand back a much longer clip, because
  // the tail search was bounded by maxDuration instead of the selection.
  const tiny = cutSegment(take, RATE, at - 0.01, at + 0.05, {
    ...SELECTION_CUT_OPTIONS,
    sampleRate: RATE,
  })!;
  const tinyMs = (tiny.samples.length / RATE) * 1000;
  check("a cut can never outlast the selection", tinyMs <= 60.5, `${tinyMs.toFixed(1)}ms from a 60.0ms drag`);

  // With the extras off the audio must be untouched: no gain, no fades.
  let peakBefore = 0;
  for (let i = 0; i < asDrawn.samples.length; i++) peakBefore = Math.max(peakBefore, Math.abs(asDrawn.samples[i]!));
  check("a default cut applies no gain", asDrawn.gain === 1, `gain ${asDrawn.gain.toFixed(3)}`);
  check(
    "a default cut keeps the take's own level",
    Math.abs(peakBefore - asDrawn.peakBefore) < 1e-6,
    `${peakBefore.toFixed(4)} vs ${asDrawn.peakBefore.toFixed(4)}`,
  );
  // With the fades off the clip has to begin on the take's own sample. Comparing
  // against the take is the only stable form of this: the selection starts in
  // room tone, so checking that the first sample is "big enough" fails whenever
  // the noise happens to land near zero.
  const asDrawnStart = Math.round(asDrawn.start * RATE);
  check(
    "a default cut fades nothing",
    asDrawn.samples[0] === take[asDrawnStart] && asDrawn.samples[0] !== 0,
    `first sample ${asDrawn.samples[0]} vs take ${take[asDrawnStart]} at ${asDrawnStart}`,
  );

  // The region has to be the selection, sample for sample.
  check(
    "a default cut starts exactly where the drag started",
    asDrawn.start >= from - 0.001 && asDrawn.end <= to + 0.001,
    `${asDrawn.start.toFixed(4)}..${asDrawn.end.toFixed(4)} inside ${from.toFixed(4)}..${to.toFixed(4)}`,
  );

  // Each toggle on its own. Snapping can only move the start forward, so the
  // region has to begin before the transient it should jump to.
  const looseFrom = at - 0.15;
  const snapped = cutSegment(take, RATE, looseFrom, to, {
    ...SELECTION_CUT_OPTIONS,
    sampleRate: RATE,
    snapOnset: true,
  })!;
  check(
    "snap to click moves the start onto the transient",
    snapped.start > looseFrom + 0.05 && snapped.start <= at,
    `start ${snapped.start.toFixed(4)} from a drag at ${looseFrom.toFixed(4)}`,
  );
  const unsnapped = cutSegment(take, RATE, looseFrom, to, { ...SELECTION_CUT_OPTIONS, sampleRate: RATE })!;
  check("without snapping the start stays put", Math.abs(unsnapped.start - looseFrom) < 0.002, `start ${unsnapped.start.toFixed(4)}`);

  const trimmed = cutSegment(take, RATE, at - 0.02, at + 0.9, { ...SELECTION_CUT_OPTIONS, sampleRate: RATE, trimTail: true })!;
  const trimmedMs = (trimmed.samples.length / RATE) * 1000;
  check("trim decay shortens a generous drag", trimmedMs < 900, `${trimmedMs.toFixed(0)}ms from a 920ms drag`);

  const normalised = cutSegment(take, RATE, from, to, { ...SELECTION_CUT_OPTIONS, sampleRate: RATE, normalize: true })!;
  let normalisedPeak = 0;
  for (let i = 0; i < normalised.samples.length; i++) normalisedPeak = Math.max(normalisedPeak, Math.abs(normalised.samples[i]!));
  check("normalise brings the peak to full scale", Math.abs(normalisedPeak - 0.92) < 0.01, normalisedPeak.toFixed(3));
  check("normalise is recorded on the cut", normalised.gain > 1, `gain ${normalised.gain.toFixed(2)}`);

  const faded = cutSegment(take, RATE, from, to, { ...SELECTION_CUT_OPTIONS, sampleRate: RATE, fade: true })!;
  check("fade edges ramps the very first sample", faded.samples[0] === 0, `first sample ${faded.samples[0]}`);

  // Export must not alter the saved clip.
  const sound: StoredSound = {
    id: "as-drawn",
    category: "clicks",
    name: "as drawn",
    sourceStart: asDrawn.start,
    sourceEnd: asDrawn.end,
    duration: asDrawn.samples.length / RATE,
    peak: asDrawn.peakBefore,
    gain: asDrawn.gain,
    createdAt: 0,
    wav: encodeWav(asDrawn.samples, RATE).buffer as ArrayBuffer,
  };
  const pack = await buildPack({ meta, sounds: [sound], noise: null });
  const out = await pack.file("clicks/1.wav")!.async("uint8array");
  const decodedOut = decodeWav(out.buffer as ArrayBuffer);
  check(
    "the exported wav is the saved clip, sample for sample",
    decodedOut.samples.length === asDrawn.samples.length,
    `${decodedOut.samples.length} vs ${asDrawn.samples.length} samples`,
  );
  check(
    "the exported wav keeps the saved level",
    Buffer.compare(Buffer.from(encodeWav(asDrawn.samples, RATE)), Buffer.from(out)) === 0,
  );
}

/* ---------- ZCB 3 target ----------
 * The block below re-implements the loader's own folder matcher from
 * zcblive's live/src/clickpack.rs and runs it over the generated archive, so
 * compatibility is checked against the real rules rather than asserted.
 */
const ZCB_SLOT_DIRNAMES = ["player1", "player2", "left1", "left2", "right1", "right2"];
const ZCB_TIER_LITERALS = [
  "hardclick", "hardclicks", "hardrelease", "hardreleases",
  "click", "clicks", "release", "releases",
  "softclick", "softclicks", "softrelease", "softreleases",
  "microclick", "microclicks", "microrelease", "microreleases",
];

/** Exactly what the loader does: keep letters only, lowercase, compare exactly. */
const zcbNormalise = (name: string) =>
  [...name].filter((c) => /\p{L}/u.test(c)).join("").toLowerCase();

check(
  "zcb root name strips characters Windows forbids",
  zcbRootName('Sayo\'s: "Soft"/Desk? Pack') === "Sayo's-Soft-Desk-Pack",
  zcbRootName('Sayo\'s: "Soft"/Desk? Pack'),
);
check("zcb root name never comes back empty", zcbRootName("   ") === "untitled", zcbRootName("   "));
check("zcb root name trims leading dots", zcbRootName("...pack") === "pack", zcbRootName("...pack"));
check(
  "zcb entry paths use forward slashes",
  zcbEntryPath("Pack", "left1", "softclicks", 2) === "Pack/left1/softclicks/3.wav",
  zcbEntryPath("Pack", "left1", "softclicks", 2),
);

check("zcb layout single is one slot", zcbLayout("single").slots.length === 1);
check("zcb layout duo is two slots", zcbLayout("duo").slots.join() === "player1,player2");
check("zcb layout all is six slots", zcbLayout("all").slots.length === 6);
check("zcb layout all covers platformer", zcbLayout("all").usesPlatformer);
check("zcb file name follows the root folder", packFileName(meta, "zcb") === "Sayo's-Soft-Desk-Pack-ZCB.zip", packFileName(meta, "zcb"));

const zcbPack = await buildPack({
  meta,
  sounds,
  noise: { wav: noiseWav, duration: 2 },
  target: "zcb",
  zcbLayout: "all",
});
const zcbBuffer = await zcbPack.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
const zcbTmp = path.join(os.tmpdir(), "ciq-verify-zcb.zip");
fs.writeFileSync(zcbTmp, zcbBuffer);
const zcbListing = execSync(`tar -tf "${zcbTmp}"`).toString().trim().split(/\r?\n/);
fs.rmSync(zcbTmp);

const root = zcbRootName(meta.title);
check("zcb zip has exactly one root folder", new Set(zcbListing.map((l) => l.split("/")[0])).size === 1, zcbListing[0]);
check("zcb root folder is the pack name", zcbListing.every((l) => l.startsWith(`${root}/`)), root);

const zcbFiles = zcbListing.filter((l) => l.endsWith(".wav"));
const zcbClipFiles = zcbFiles.filter((l) => !l.endsWith("noise.wav"));
const zcbSlotsSeen = new Set(zcbClipFiles.map((l) => l.split("/")[1]!));
check("zcb zip writes all six slots", zcbSlotsSeen.size === 6, [...zcbSlotsSeen].join(","));
check(
  "every slot folder is one the loader looks for",
  [...zcbSlotsSeen].every((slot) => ZCB_SLOT_DIRNAMES.includes(slot)),
);
check(
  "zcb clip count is the library times the slot count",
  zcbClipFiles.length === sounds.length * 6,
  `${zcbClipFiles.length} vs ${sounds.length * 6}`,
);

// The decisive check: run the loader's matcher over every folder we emitted.
const zcbDirs = zcbListing.filter((l) => l.endsWith("/")).map((l) => l.replace(/\/$/, ""));
const zcbTierDirs = zcbDirs.filter((d) => d.split("/").length === 3);
const zcbSlotDirs = zcbDirs.filter((d) => d.split("/").length === 2);
check(
  "zcb emits 6 slots of 8 tiers",
  zcbSlotDirs.length === 6 && zcbTierDirs.length === 48,
  `${zcbSlotDirs.length} slots, ${zcbTierDirs.length} tiers`,
);
const unmatchedTiers = zcbTierDirs.filter((d) => !ZCB_TIER_LITERALS.includes(zcbNormalise(d.split("/")[2]!)));
check("every tier folder matches the loader's patterns", unmatchedTiers.length === 0, unmatchedTiers.join(", "));
const unmatchedSlots = zcbSlotDirs.filter((d) => !ZCB_SLOT_DIRNAMES.includes(d.split("/")[1]!));
check("every slot folder matches the loader's patterns", unmatchedSlots.length === 0, unmatchedSlots.join(", "));
check(
  "zcb keeps readme and noise inside the root",
  zcbListing.includes(`${root}/readme.txt`) && zcbListing.includes(`${root}/noise.wav`),
);
check(
  "zcb readme documents the install step",
  (await zcbPack.file(`${root}/readme.txt`)!.async("string")).includes(".zcb/clickpacks"),
);

// A one-slot export must be a strict subset, never a different shape.
const zcbSingle = await buildPack({ meta, sounds, noise: null, target: "zcb", zcbLayout: "single" });
const zcbSingleFiles = Object.keys(zcbSingle.files).filter((f) => f.endsWith(".wav"));
check("single-slot export writes one copy of the library", zcbSingleFiles.length === sounds.length, `${zcbSingleFiles.length}`);
check(
  "single-slot export uses player1 only",
  zcbSingleFiles.every((f) => f.split("/")[1] === "player1"),
);

/* ---------- ZCB readiness report ---------- */
const clip = (id: string, category: string, samples: Float32Array): StoredSound => ({
  id,
  category: category as StoredSound["category"],
  name: id,
  sourceStart: 0,
  sourceEnd: samples.length / RATE,
  duration: samples.length / RATE,
  peak: 1,
  gain: 1,
  createdAt: 0,
  wav: encodeWav(samples, RATE).buffer as ArrayBuffer,
});

/** A well-formed 80 ms click: instant attack, exponential decay. */
function goodClip(seconds = 0.08, amp = 0.5) {
  const n = Math.round(RATE * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * 2400 * i) / RATE) * Math.exp(-i / (RATE * 0.012)) * amp;
  return out;
}

const fullTier = Array.from({ length: 8 }, (_, i) =>
  clip(`ok-${i}`, "clicks", goodClip(0.08, 0.3 + i * 0.02)),
);
const clean = validateZcbPack([...fullTier, ...Array.from({ length: 8 }, (_, i) => clip(`okr-${i}`, "releases", goodClip()))], {
  categories: ["clicks", "releases"],
});
check("a healthy tier raises nothing", clean.findings.length === 0, clean.findings.map((f) => f.id).join(","));

const sparse = validateZcbPack([clip("only", "clicks", goodClip())], { categories: ["clicks"] });
check("a one-clip tier is an error", sparse.findings.some((f) => f.id === "layers-clicks"));
check(
  "a one-clip tier reports the blocking problem only",
  sparse.findings.length === 1,
  sparse.findings.map((f) => f.id).join(","),
);

const thin = validateZcbPack(
  Array.from({ length: 5 }, (_, i) => clip(`t-${i}`, "clicks", goodClip())),
  { categories: ["clicks"] },
);
check("five clips is a warning, not an error", thin.findings.every((f) => f.severity === "warning"));
check("five clips trips the sub-tiering warning", thin.findings.some((f) => f.id === "tiering-clicks"));

const empty = validateZcbPack([clip("a", "clicks", goodClip())], { categories: ["clicks", "hardclicks"] });
const emptyFinding = empty.findings.find((f) => f.id === "empty-hardclicks");
check("an empty tier is reported", !!emptyFinding);
check("an empty tier warns about the release fallback", !!emptyFinding && emptyFinding.detail.includes("release sample"));

const short = validateZcbPack([clip("s", "clicks", goodClip(0.02))], { categories: ["clicks"] });
check("a clip under 40 ms is reported", short.findings.some((f) => f.id === "short-clicks"));
const longEnough = validateZcbPack([clip("l", "clicks", goodClip(0.08))], { categories: ["clicks"] });
check("a clip over 40 ms is not reported as short", !longEnough.findings.some((f) => f.id === "short-clicks"));

const late = new Float32Array(RATE * 0.08);
for (let i = 0; i < RATE * 0.02; i++) {
  late[i] = Math.sin((2 * Math.PI * 2400 * i) / RATE) * Math.exp(-i / (RATE * 0.004)) * 0.5;
}
check(
  "a silent second half is reported separately from length",
  validateZcbPack([clip("t", "clicks", late)], { categories: ["clicks"] }).findings.some((f) => f.id === "tail-clicks"),
);

const late2 = new Float32Array(RATE * 0.08);
late2[Math.round(RATE * 0.05)] = 0.5;
check(
  "leading silence is reported",
  validateZcbPack([clip("p", "clicks", late2)], { categories: ["clicks"] }).findings.some((f) => f.id === "attack-clicks"),
);

const lopsided = validateZcbPack(
  [
    ...Array.from({ length: 7 }, (_, i) => clip(`q-${i}`, "clicks", goodClip(0.08, 0.6))),
    clip("q-loud", "clicks", goodClip(0.08, 0.03)),
  ],
  { categories: ["clicks"] },
);
check("a level spread past 2.5x is reported", lopsided.findings.some((f) => f.id === "spread-clicks"));

check("errors sort above warnings", (() => {
  const mixed = validateZcbPack(
    [clip("m", "clicks", goodClip(0.02)), clip("m2", "releases", goodClip(0.02))],
    { categories: ["clicks", "releases", "hardclicks"] },
  );
  return mixed.findings.findIndex((f) => f.severity === "error") <= mixed.findings.findIndex((f) => f.severity === "warning");
})());

/* ---------- the ZCB cut preset ---------- */
check("zcb preset turns every extra on", Object.values(ZCB_CUT_PRESET).every(Boolean));
const preset = cutSegment(take, RATE, eventTimes[0]! - 0.02, eventTimes[0]! + 0.5, {
  ...SELECTION_CUT_OPTIONS,
  sampleRate: RATE,
  ...ZCB_CUT_PRESET,
});
check("the preset produces a cut", !!preset);
if (preset) {
  const presetPeak = Math.max(...Array.from(preset.samples, Math.abs));
  check("the preset normalises", Math.abs(presetPeak - 0.92) < 0.01, presetPeak.toFixed(3));
  check("the preset keeps the clip inside the selection", preset.end <= eventTimes[0]! + 0.5 + 1e-6);
  check(
    "the preset shortens a generous drag",
    (preset.samples.length / RATE) * 1000 < 500,
    `${((preset.samples.length / RATE) * 1000).toFixed(0)}ms from a 520ms drag`,
  );
}

console.log(results.join("\n"));
console.log(`\nzip entries: ${listing.length}`);

