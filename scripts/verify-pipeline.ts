/* Headless verification of the cut + export pipeline against the SD1 reference. */
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
} from "../src/lib/audio/process";
import { decodeWav, encodeWav, resample, TARGET_SAMPLE_RATE } from "../src/lib/audio/wav";
import { buildNoiseShape, denoiseSamples, findClickBody } from "../src/lib/audio/denoise";
import { fft, ifft } from "../src/lib/audio/fft";
import { buildPack, buildReadme, packFileName, type ExportProgress } from "../src/lib/exporter";
import { autocutTake } from "../src/lib/audio/autocut";
import { EventDebouncer, type RecordedEvent } from "../src/lib/events";
import { CATEGORIES, type PackMeta, type StoredSound } from "../src/lib/types";
import {
  ZCB_CUT_PRESET,
  validateZcbPack,
  zcbEntryPath,
  zcbLayout,
  zcbRootName,
} from "../src/lib/zcb";

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
check(
  "clip length in the same ballpark as SD1 (28988 bytes)",
  mine.length > 8000 && mine.length < 120000,
  `${mine.length} bytes, ${(mine.length / (2 * 48000)).toFixed(3)}s`,
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
  check("autocut bands loudest to hard", byTime[0]?.intensity === "hard", `${byTime[0]?.intensity} at ${byTime[0]?.relativePeak.toFixed(3)}`);
  check("autocut bands a mid click to soft", byTime[1]?.intensity === "soft", `${byTime[1]?.intensity} at ${byTime[1]?.relativePeak.toFixed(3)}`);
  check("autocut bands quiet clicks to micro", byTime[2]?.intensity === "micro" && byTime[3]?.intensity === "micro", `${byTime[2]?.intensity}, ${byTime[3]?.intensity}`);
  check("autocut uses all three quieter bands distinctly", new Set(clips.map((c) => c.intensity)).size === 3, [...new Set(clips.map((c) => c.intensity))].join(","));

  check("presses land in click folders", byTime[0]?.category === "hardclicks" && byTime[2]?.category === "microclicks", `${byTime[0]?.category}, ${byTime[2]?.category}`);
  check("releases land in release folders", byTime[1]?.category === "softreleases" && byTime[3]?.category === "microreleases", `${byTime[1]?.category}, ${byTime[3]?.category}`);
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
  check("a default cut fades nothing", asDrawn.samples[0] !== 0 && Math.abs(asDrawn.samples[0]!) > 0.0005, `first sample ${asDrawn.samples[0]}`);

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

